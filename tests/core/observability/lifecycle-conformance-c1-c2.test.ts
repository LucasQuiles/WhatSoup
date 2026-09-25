// FLOS conformance fixtures C1 (clean) and C2 (stalled) — AUTHORED RED in
// Stage 1 per plan §3; they gate GREEN in Stage 2, which lands the settlement
// predicates and condition classes they assert (design §12).
//
// Mechanism: every conformance case is `it.fails` around a dynamic import of
// the Stage 2 settlement module. Today the import rejects, the case is red by
// contract, and `it.fails` keeps CI green. The moment Stage 2 lands
// `lifecycle-settlement.ts` and the predicates pass, these cases start
// FAILING CI until each `it.fails` is flipped to `it` — the flip is the
// Stage 2 gate, and it cannot be forgotten silently.
//
// The fixtures drive the REAL Stage 1 store (real SQLite, repo convention):
// the event sequences below are the canonical C1/C2 corpora and are already
// consumed by the store round-trip assertions (green today) so the data
// itself cannot rot while it waits for Stage 2.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLifecycleEventStore } from '../../../src/core/observability/lifecycle-event-store.ts';
import type { LifecycleEvent, LifecycleLane, LifecyclePhase } from '../../../src/core/observability/lifecycle-event.ts';

// Stage 2 module — intentionally absent in Stage 1. Variable specifier keeps
// tsc from resolving it statically; the dynamic import rejects at runtime.
const STAGE2_SETTLEMENT_MODULE = '../../../src/core/observability/lifecycle-settlement.ts';

const AT = '2026-08-29T03:00:00Z';
const AT_MS = Date.parse(AT);

let dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flos-conformance-'));
  dirs.push(dir);
  return join(dir, 'events.sqlite3');
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface ChainSpec {
  lane: LifecycleLane;
  origin_lane?: LifecycleLane;
  work_id: string;
  phases: readonly LifecyclePhase[];
  correlation?: LifecycleEvent['correlation'];
}

/** Queue-mediated lanes settle on `released`; queue:none lanes on `finalized` (design §2). */
const QUEUE_MEDIATED_CHAIN: readonly LifecyclePhase[] = [
  'admitted', 'dispatched', 'acknowledged', 'progress', 'tool_effect',
  'terminal_result', 'finalized', 'delivered', 'released',
];
const QUEUE_NONE_CHAIN: readonly LifecyclePhase[] = [
  'admitted', 'dispatched', 'progress', 'terminal_result', 'finalized',
];

function emitChain(store: ReturnType<typeof createLifecycleEventStore>, spec: ChainSpec, monoStart: number): void {
  spec.phases.forEach((phase, index) => {
    const event: LifecycleEvent = {
      schema: 'whatsoup.lifecycle.event.v1',
      instance: 'instance-alpha',
      host: 'host-1',
      lane: spec.lane,
      origin_lane: spec.origin_lane ?? null,
      work_id: spec.work_id,
      correlation: spec.correlation ?? {},
      phase,
      at_utc: AT,
      boot_id: 'boot-1',
      mono_ms: monoStart + index * 1000,
      attrs: phase === 'released' || phase === 'finalized'
        ? { manager_generation: 1, manager_digest: 'k1:' + 'a'.repeat(64) }
        : {},
    };
    const result = store.append(event);
    expect(result.accepted, `${spec.lane}/${spec.work_id}/${phase}`).toBe(true);
  });
}

/** C1 corpus: every lane settles. */
const C1_CHAINS: readonly ChainSpec[] = [
  { lane: 'L-INT', work_id: 'int-1', phases: QUEUE_MEDIATED_CHAIN, correlation: { inbound_seq: 101, logical_turn_id: 'turn-1' } },
  { lane: 'L-SCH', work_id: 'sch-1', phases: QUEUE_MEDIATED_CHAIN, correlation: { trigger_occurrence_id: 'occ-1' } },
  { lane: 'L-REC', origin_lane: 'L-INT', work_id: 'rec-1', phases: ['recovery_claimed', 'progress', 'recovery_completed', 'finalized', 'released'], correlation: { inbound_seq: 101 } },
  { lane: 'L-CTL', work_id: 'ctl-1', phases: QUEUE_NONE_CHAIN },
  { lane: 'L-PRB', work_id: 'prb-1', phases: QUEUE_NONE_CHAIN },
  { lane: 'L-OUT', work_id: 'out-1', phases: ['admitted', 'dispatched', 'delivered', 'finalized'], correlation: { outbound_op_id: 'op-1' } },
];

/** C2 corpus: terminal_result WITHHELD on sch-stalled (queued follower ⇒ V1) and int-solitary (nothing behind ⇒ P1). */
const C2_CHAINS: readonly ChainSpec[] = [
  { lane: 'L-SCH', work_id: 'sch-stalled', phases: ['admitted', 'dispatched', 'acknowledged', 'progress', 'tool_effect'], correlation: { trigger_occurrence_id: 'occ-9' } },
  { lane: 'L-SCH', work_id: 'sch-queued-behind', phases: ['admitted'], correlation: { trigger_occurrence_id: 'occ-10' } },
  { lane: 'L-INT', work_id: 'int-solitary', phases: ['admitted', 'dispatched', 'acknowledged', 'progress'], correlation: { inbound_seq: 202 } },
];

describe('conformance corpora load into the Stage 1 store (green today — data cannot rot)', () => {
  it('C1 and C2 chains append and read back completely', () => {
    const store = createLifecycleEventStore({ path: tempDb(), nowEpochMs: () => AT_MS });
    let mono = 0;
    for (const chain of [...C1_CHAINS, ...C2_CHAINS]) {
      emitChain(store, chain, mono);
      mono += 100_000;
    }
    const c1Rows = C1_CHAINS.reduce((n, c) => n + c.phases.length, 0);
    const c2Rows = C2_CHAINS.reduce((n, c) => n + c.phases.length, 0);
    expect(store.counters().rows).toBe(c1Rows + c2Rows);
    expect(store.readEvents({ work_id: 'sch-stalled' }).map((e) => e.phase)).not.toContain('terminal_result');
    store.close();
  });
});

describe('C1 clean (design §12) — RED until Stage 2 lands settlement predicates', () => {
  it.fails('every lane settles (queue-mediated via released, queue:none via finalized); zero conditions', async () => {
    const store = createLifecycleEventStore({ path: tempDb(), nowEpochMs: () => AT_MS });
    let mono = 0;
    for (const chain of C1_CHAINS) { emitChain(store, chain, mono); mono += 100_000; }
    const settlement = (await import(/* @vite-ignore */ STAGE2_SETTLEMENT_MODULE)) as {
      evaluateSettlement: (store: unknown, opts: { now_epoch_ms: number }) => {
        settled: boolean;
        open_conditions: Array<{ class: string }>;
      };
    };
    const verdict = settlement.evaluateSettlement(store, { now_epoch_ms: AT_MS + 600_000 });
    expect(verdict.settled).toBe(true);
    expect(verdict.open_conditions).toEqual([]);
    store.close();
  });
});

describe('C2 stalled (design §12) — RED until Stage 2 lands V1/P1 condition classes', () => {
  it.fails('withheld terminal_result ⇒ V1 for the joined case and P1 for the solitary case, within bounds', async () => {
    const store = createLifecycleEventStore({ path: tempDb(), nowEpochMs: () => AT_MS });
    let mono = 0;
    for (const chain of C2_CHAINS) { emitChain(store, chain, mono); mono += 100_000; }
    const settlement = (await import(/* @vite-ignore */ STAGE2_SETTLEMENT_MODULE)) as {
      evaluateSettlement: (store: unknown, opts: { now_epoch_ms: number }) => {
        settled: boolean;
        open_conditions: Array<{ class: string; work_id?: string }>;
      };
    };
    // Evaluate one hour past the corpus timestamps — well past any settlement bound.
    const verdict = settlement.evaluateSettlement(store, { now_epoch_ms: AT_MS + 3_600_000 });
    expect(verdict.settled).toBe(false);
    const classes = verdict.open_conditions.map((c) => c.class).sort();
    expect(classes).toContain('V1'); // sch-stalled with sch-queued-behind behind it
    expect(classes).toContain('P1'); // int-solitary with nothing queued behind
    store.close();
  });
});
