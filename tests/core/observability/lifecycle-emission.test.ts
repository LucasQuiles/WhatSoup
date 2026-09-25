// FLOS Stage 1 — the runtime emission gate (plan §3): phase-gated emitter,
// #2566 lane classification, minted per-process boot_id, and the never-throw
// contract. Real SQLite store per repo convention; injectable clocks.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  __setRuntimeLifecycleEmitterForTests,
  attemptOutcomeToken,
  classifyTurnLane,
  createLifecycleEmitter,
  initializeRuntimeLifecycleEmitter,
  runtimeLifecycleEmitter,
} from '../../../src/core/observability/lifecycle-emission.ts';
import { createLifecycleEventStore, type LifecycleEventStore } from '../../../src/core/observability/lifecycle-event-store.ts';
import type { LifecycleEvent } from '../../../src/core/observability/lifecycle-event.ts';

const AT_MS = Date.parse('2026-08-29T03:00:00Z');

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flos-emit-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  __setRuntimeLifecycleEmitterForTests(null);
});

describe('classifyTurnLane (#2566 deterministic join)', () => {
  it('classifies the synthetic agent-job message id as L-SCH with its occurrence id', () => {
    expect(classifyTurnLane('agentjob-12-1787969434-occ7')).toEqual({
      lane: 'L-SCH',
      trigger_occurrence_id: '7',
    });
  });

  it('classifies ordinary inbound ids and absent ids as L-INT', () => {
    expect(classifyTurnLane('3EB0EE893DC06E905257DD')).toEqual({ lane: 'L-INT' });
    expect(classifyTurnLane(undefined)).toEqual({ lane: 'L-INT' });
    expect(classifyTurnLane(null)).toEqual({ lane: 'L-INT' });
  });

  it('requires the strict numeric agentjob shape — lookalikes stay L-INT', () => {
    expect(classifyTurnLane('agentjob-x-y-occz')).toEqual({ lane: 'L-INT' });
    expect(classifyTurnLane('agentjob-12-34-occ')).toEqual({ lane: 'L-INT' });
    expect(classifyTurnLane('agentjob-12-34-occ5-extra')).toEqual({ lane: 'L-INT' });
  });
});

describe('attemptOutcomeToken', () => {
  it('passes well-formed outcome kinds through unchanged', () => {
    expect(attemptOutcomeToken('completed')).toBe('completed');
    expect(attemptOutcomeToken('provider_failure')).toBe('provider_failure');
  });

  it('sanitizes arbitrary strings into envelope-safe enum tokens', () => {
    expect(attemptOutcomeToken('Weird Kind! With+Content')).toMatch(/^[a-z][a-z0-9_.:-]{0,63}$/);
    expect(attemptOutcomeToken('')).toMatch(/^[a-z][a-z0-9_.:-]{0,63}$/);
    expect(attemptOutcomeToken('123')).toMatch(/^[a-z][a-z0-9_.:-]{0,63}$/);
  });
});

describe('phase off (dark default)', () => {
  it('is inert: no store file is created and emit reports not-emitted', () => {
    const path = join(tempDir(), 'lifecycle-events.db');
    const emitter = createLifecycleEmitter({ phase: 'off', storePath: path, instance: 'inst-a' });
    expect(emitter.enabled).toBe(false);
    expect(emitter.emit({ lane: 'L-INT', work_id: 'w1', phase: 'admitted' })).toBe(false);
    expect(existsSync(path)).toBe(false);
    emitter.close();
  });

  it('fails closed on an unknown or absent phase value — never emits', () => {
    const path = join(tempDir(), 'lifecycle-events.db');
    for (const phase of ['bogus', undefined, null, 1] as const) {
      const emitter = createLifecycleEmitter({ phase: phase as never, storePath: path, instance: 'inst-a' });
      expect(emitter.enabled, String(phase)).toBe(false);
      expect(emitter.emit({ lane: 'L-INT', work_id: 'w1', phase: 'admitted' })).toBe(false);
      emitter.close();
    }
    expect(existsSync(path)).toBe(false);
  });
});

describe('phase shadow (emitting)', () => {
  it('emits a complete event.v1 envelope with minted boot_id and integer mono_ms', () => {
    const path = join(tempDir(), 'lifecycle-events.db');
    const emitter = createLifecycleEmitter({
      phase: 'shadow',
      storePath: path,
      instance: 'inst-a',
      host: 'host-1',
      monotonicNow: () => 1234.6,
      nowEpochMs: () => AT_MS,
    });
    expect(emitter.enabled).toBe(true);
    const ok = emitter.emit({
      lane: 'L-SCH',
      work_id: 'agentjob-1-2-occ3',
      phase: 'admitted',
      correlation: { trigger_occurrence_id: '3', inbound_seq: 41 },
      attrs: { trigger_id: 1 },
    });
    expect(ok).toBe(true);
    emitter.close();

    const store = createLifecycleEventStore({ path, nowEpochMs: () => AT_MS });
    const rows = store.readEvents({ work_id: 'agentjob-1-2-occ3' });
    expect(rows).toHaveLength(1);
    const event = rows[0]!;
    expect(event.lane).toBe('L-SCH');
    expect(event.instance).toBe('inst-a');
    expect(event.host).toBe('host-1');
    expect(event.boot_id).toBe(emitter.bootId);
    expect(event.mono_ms).toBe(1235);
    expect(event.at_utc).toBe('2026-08-29T03:00:00.000Z');
    expect(event.correlation).toEqual({ trigger_occurrence_id: '3', inbound_seq: 41 });
    expect(event.attrs).toEqual({ trigger_id: 1 });
    store.close();
  });

  it('mints a distinct boot_id per emitter and keeps it stable across emits', () => {
    const dir = tempDir();
    const a = createLifecycleEmitter({ phase: 'shadow', storePath: join(dir, 'a.db'), instance: 'i' });
    const b = createLifecycleEmitter({ phase: 'shadow', storePath: join(dir, 'b.db'), instance: 'i' });
    expect(a.bootId).not.toBe(b.bootId);
    a.emit({ lane: 'L-INT', work_id: 'w1', phase: 'admitted' });
    a.emit({ lane: 'L-INT', work_id: 'w1', phase: 'finalized' });
    a.close();
    const store = createLifecycleEventStore({ path: join(dir, 'a.db'), nowEpochMs: () => AT_MS });
    const bootIds = new Set(store.readEvents({}).map((e) => e.boot_id));
    expect([...bootIds]).toEqual([a.bootId]);
    store.close();
    b.close();
  });

  it('drops an invalid envelope fail-closed: returns false, counted, never thrown', () => {
    const path = join(tempDir(), 'lifecycle-events.db');
    const emitter = createLifecycleEmitter({ phase: 'shadow', storePath: path, instance: 'inst-a', nowEpochMs: () => AT_MS });
    const ok = emitter.emit({
      lane: 'L-INT',
      work_id: 'w1',
      phase: 'admitted',
      attrs: { note: 'free-form text with spaces — must be rejected' },
    });
    expect(ok).toBe(false);
    emitter.close();
    const store = createLifecycleEventStore({ path, nowEpochMs: () => AT_MS });
    expect(store.counters().dropped['invalid_envelope']).toBe(1);
    expect(store.readEvents({})).toHaveLength(0);
    store.close();
  });

  it('never throws when the store itself fails', () => {
    const broken = {
      append: () => { throw new Error('disk gone'); },
      close: () => { throw new Error('also broken'); },
    } as unknown as LifecycleEventStore;
    const emitter = createLifecycleEmitter({
      phase: 'shadow',
      storePath: join(tempDir(), 'unused.db'),
      instance: 'inst-a',
      store: broken,
    });
    expect(emitter.emit({ lane: 'L-INT', work_id: 'w1', phase: 'admitted' })).toBe(false);
    expect(() => emitter.close()).not.toThrow();
  });
});

describe('runtime singleton (config-free domain module)', () => {
  it('is inert until initialized — uninitialized access never emits', () => {
    const emitter = runtimeLifecycleEmitter();
    expect(emitter.enabled).toBe(false);
    expect(emitter.emit({ lane: 'L-INT', work_id: 'w', phase: 'admitted' })).toBe(false);
  });

  it('initializes once from a build thunk; later initializations are no-ops', () => {
    const path = join(tempDir(), 'lifecycle-events.db');
    const first = initializeRuntimeLifecycleEmitter(() => ({ phase: 'shadow', storePath: path, instance: 'inst-a' }));
    expect(first.enabled).toBe(true);
    const second = initializeRuntimeLifecycleEmitter(() => ({ phase: 'shadow', storePath: path, instance: 'OTHER' }));
    expect(second).toBe(first);
    expect(runtimeLifecycleEmitter()).toBe(first);
    first.close();
  });

  it('latches INERT when the build thunk throws (fail-closed, never throws)', () => {
    const emitter = initializeRuntimeLifecycleEmitter(() => { throw new Error('no dataRoot in this context'); });
    expect(emitter.enabled).toBe(false);
    expect(runtimeLifecycleEmitter()).toBe(emitter);
  });

  it('returns the injected test emitter', () => {
    const captured: LifecycleEvent[] = [];
    const fake = {
      enabled: true,
      bootId: 'boot-test',
      emit: (input: unknown) => { captured.push(input as LifecycleEvent); return true; },
      close: () => {},
    };
    __setRuntimeLifecycleEmitterForTests(fake);
    const emitter = runtimeLifecycleEmitter();
    expect(emitter).toBe(fake);
    emitter.emit({ lane: 'L-INT', work_id: 'w', phase: 'admitted' } as never);
    expect(captured).toHaveLength(1);
  });
});
