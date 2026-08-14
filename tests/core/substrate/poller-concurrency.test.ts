// #2566 slice 2 — bounded concurrency and hang isolation.
// One hung executor must not block unrelated due triggers (F1) and must not
// wedge the tick timer (F2). Probe executions are bounded by a pool (F5),
// timed out safely (F6), and side-effecting kinds stay strictly serial (F7).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { createTrigger } from '../../../src/core/substrate/triggers.ts';
import { TriggerPoller } from '../../../src/core/substrate/poller.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';

function tmpFile() { return join(tmpdir(), `conc-${randomBytes(8).toString('hex')}.db`); }

function makeMessenger() {
  const calls: Array<{ chatJid: string; text: string }> = [];
  const messenger: Messenger = {
    async sendMessage(chatJid: string, text: string): Promise<SubmissionReceipt> {
      calls.push({ chatJid, text });
      return { waMessageId: `wa-${calls.length}` };
    },
    async sendMedia() { throw new Error('not used'); },
  };
  return { messenger, calls };
}

function makeProbeTrigger(db: Database, nextFireAt: number, title: string) {
  const bead = createBead(db.raw, { kind: 'watch', title, ownerJid: 'mw', actor: 'u' });
  db.raw.exec(`CREATE TABLE IF NOT EXISTS probes (id INTEGER PRIMARY KEY)`);
  return createTrigger(db.raw, {
    beadId: bead.id, kind: 'poll.sqlite',
    spec: { sql: `SELECT id FROM probes`, fire_when: 'rows_returned' },
    reportChatJid: 'admin@s.whatsapp.net',
    intervalSeconds: 60, nextFireAt,
    actor: 'u',
  });
}

type ExecSpy = { executeTrigger(trigger: { id: number }): Promise<unknown> };

function occurrenceStates(db: Database, triggerId: number): string[] {
  return (db.raw.prepare(
    `SELECT state FROM trigger_occurrences WHERE trigger_id = ? ORDER BY id`,
  ).all(triggerId) as Array<{ state: string }>).map((r) => r.state);
}

describe('TriggerPoller — hang isolation and bounded concurrency (#2566 slice 2)', () => {
  let path: string;
  let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('F1: a hung executor does not block an unrelated due trigger in the same tick', async () => {
    const { messenger } = makeMessenger();
    const a = makeProbeTrigger(db, 1_000_000_000, 'hung');
    const b = makeProbeTrigger(db, 1_000_000_000, 'healthy');
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });

    let release!: () => void;
    const held = new Promise<never>((_resolve, reject) => { release = () => reject(new Error('released')); });
    const real = (poller as unknown as ExecSpy).executeTrigger.bind(poller);
    vi.spyOn(poller as unknown as ExecSpy, 'executeTrigger').mockImplementation((t) => {
      if ((t as { id: number }).id === a.id) return held as Promise<unknown>;
      return real(t as { id: number });
    });

    const tick = poller.tickOnce();
    // While A hangs, B must reach a terminal occurrence state.
    await vi.waitFor(() => {
      const states = occurrenceStates(db, b.id);
      expect(states).toHaveLength(1);
      expect(['ok', 'noop']).toContain(states[0]);
    }, { timeout: 2000 });

    release();
    await tick;
  });

  it('F2: a hung executor does not wedge the tick timer — a second tick fires', async () => {
    const { messenger } = makeMessenger();
    const a = makeProbeTrigger(db, 1_000_000_000, 'hung');
    let nowSec = 1_000_000_001;

    // Fake scheduler: collect every armed callback (tick timer AND budget
    // timer) and drain them all from the test loop. Proof of continuity is
    // the tickOnce invocation COUNT, not timer arithmetic — the budget timer
    // arming must not be mistakable for a re-armed tick.
    const scheduled: Array<() => void> = [];
    let fired = 0;
    const fakeSetTimeout = ((fn: () => void) => {
      scheduled.push(fn);
      return scheduled.length as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => nowSec,
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: (() => {}) as typeof clearTimeout,
      tickBudgetSeconds: 1,
    });

    const held = new Promise<never>(() => {});
    vi.spyOn(poller as unknown as ExecSpy, 'executeTrigger').mockImplementation(() => held as Promise<unknown>);
    const tickSpy = vi.spyOn(
      poller as unknown as { tickOnce(): Promise<number> },
      'tickOnce',
    );

    poller.start();
    await vi.waitFor(() => {
      while (fired < scheduled.length) {
        const fn = scheduled[fired++];
        nowSec += 120;
        fn();
      }
      // The first tick's executor hangs forever; a second tickOnce invocation
      // proves the run loop re-armed past it.
      expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 3000 });

    poller.stop();
    // The fake scheduler fires EVERY armed timer, including the probe
    // execution timeout — so earlier hung occurrences finalize 'failed'
    // (execution_timeout) and the latest claim is the surviving 'running'
    // evidence. Every state must be one of exactly those two.
    const states = occurrenceStates(db, a.id);
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[states.length - 1]).toBe('running');
    for (const s of states.slice(0, -1)) expect(s).toBe('failed');
  });

  it('F5: probe concurrency peaks at exactly the pool bound', async () => {
    const { messenger } = makeMessenger();
    const triggers = Array.from({ length: 6 }, (_, i) => makeProbeTrigger(db, 1_000_000_000, `p${i}`));
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      maxConcurrentExecutors: 2,
    });

    let active = 0;
    let peak = 0;
    vi.spyOn(poller as unknown as ExecSpy, 'executeTrigger').mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { status: 'noop', fired: false, outputSummary: 'probe ok', outputJson: {} };
    });

    await poller.tickOnce();
    expect(peak).toBe(2);
    for (const t of triggers) {
      expect(occurrenceStates(db, t.id)).toEqual(['noop']);
    }
  });

  it('F6: a timed-out probe finalizes failed/execution_timeout and the fenced statement refuses terminal rewrites', async () => {
    const { messenger } = makeMessenger();
    const t = makeProbeTrigger(db, 1_000_000_000, 'slow');
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      executionTimeoutSeconds: 1,
      occurrenceLeaseOwner: 'pid:test:f6',
    });

    let resolveLate!: (v: unknown) => void;
    vi.spyOn(poller as unknown as ExecSpy, 'executeTrigger').mockImplementationOnce(
      () => new Promise((resolve) => { resolveLate = resolve; }),
    );

    await poller.tickOnce();
    const row = db.raw.prepare(
      `SELECT id, state FROM trigger_occurrences WHERE trigger_id = ?`,
    ).get(t.id) as { id: number; state: string };
    expect(row.state).toBe('failed');
    const run = db.raw.prepare(
      `SELECT error_kind FROM trigger_runs WHERE trigger_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(t.id) as { error_kind: string | null };
    expect(run.error_kind).toBe('execution_timeout');

    // Late completion of the abandoned probe must not disturb the terminal row.
    resolveLate({ status: 'ok', fired: false, outputSummary: 'late', outputJson: {} });
    await new Promise((resolve) => setImmediate(resolve));

    // Drive the poller's REAL fenced statement with a matching lease against
    // the terminal row: the state guard must make it a no-op.
    const fenced = (poller as unknown as { stmtFinalizeOccurrence: { run(...a: unknown[]): { changes: number | bigint } } })
      .stmtFinalizeOccurrence.run('ok', 1_000_000_999, row.id, 'pid:test:f6', 1);
    expect(Number(fenced.changes)).toBe(0);
    const after = db.raw.prepare(
      `SELECT state FROM trigger_occurrences WHERE id = ?`,
    ).get(row.id) as { state: string };
    expect(after.state).toBe('failed');
  });

  it('F7: side-effecting kinds stay strictly serial even with free pool capacity', async () => {
    const { messenger } = makeMessenger();
    const beads = Array.from({ length: 3 }, (_, i) =>
      createBead(db.raw, { kind: 'task', title: `cron${i}`, ownerJid: 'mw', actor: 'u' }));
    const triggers = beads.map((b) =>
      createTrigger(db.raw, {
        beadId: b.id, kind: 'schedule.cron',
        spec: { expr: '*/5 * * * *' },
        reportChatJid: 'admin@s.whatsapp.net',
        nextFireAt: 1_000_000_000,
        actor: 'u',
      }));
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      maxConcurrentExecutors: 4,
    });

    let active = 0;
    let peak = 0;
    vi.spyOn(poller as unknown as ExecSpy, 'executeTrigger').mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return { status: 'ok', fired: false, outputSummary: 'cron ok', outputJson: {} };
    });

    await poller.tickOnce();
    expect(peak).toBe(1);
    for (const t of triggers) {
      expect(occurrenceStates(db, t.id)).toEqual(['ok']);
    }
  });
});
