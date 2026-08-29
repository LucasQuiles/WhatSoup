// src/core/observability/lifecycle-emission.ts
// Fleet Lifecycle Observability Standard — Stage 1 runtime emission gate
// (plan §3): the single seam through which runtime code emits event.v1
// envelopes into the private bounded store.
//
// Contracts:
// - Phase-gated: `off` (the default) is INERT — no store file is ever created,
//   emit() is a cheap boolean return. shadow/alerting/default emit.
// - Never-throw: an observer must never break the runtime. Every failure mode
//   (invalid envelope, store fault, disk gone) returns false; invalid
//   envelopes are counted by the store fail-closed.
// - Clock model (design §2 O4/O5): a per-PROCESS `boot_id` is minted here at
//   emitter creation (opaque UUID — the host boot id from process-lock.ts is
//   deliberately NOT reused: it survives process restarts, this must not);
//   `mono_ms` comes from the monotonic clock, `at_utc` is the durable witness.
// - Lane classification (#2566): scheduled turns are recognized by the
//   deterministic `agentjob-<trigger>-<unix>-occ<occurrence>` synthetic
//   message id, which also yields `trigger_occurrence_id` for correlation.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { systemClock } from '../../lib/clock.ts';
import type { FleetLifecyclePhase } from './fleet-lifecycle-flag.ts';
import type { LifecycleEvent, LifecycleLane, LifecyclePhase } from './lifecycle-event.ts';
import { createLifecycleEventStore, type LifecycleEventStore } from './lifecycle-event-store.ts';

// The #2566 slice-3 synthetic inbound id: deterministically joinable to its
// trigger_occurrences row. Strict shape — lookalikes classify as L-INT.
const AGENT_JOB_MESSAGE_ID = /^agentjob-\d+-\d+-occ(\d+)$/;

const ENUM_TOKEN = /^[a-z][a-z0-9_.:-]{0,63}$/;

export type TurnLaneClassification =
  | { lane: 'L-SCH'; trigger_occurrence_id: string }
  | { lane: 'L-INT' };

/** Classify a turn's lane from its source message id (see header). */
export function classifyTurnLane(sourceMessageId: string | null | undefined): TurnLaneClassification {
  if (sourceMessageId === null || sourceMessageId === undefined) return { lane: 'L-INT' };
  const match = AGENT_JOB_MESSAGE_ID.exec(sourceMessageId);
  if (match === null) return { lane: 'L-INT' };
  return { lane: 'L-SCH', trigger_occurrence_id: match[1] as string };
}

/**
 * Force an arbitrary outcome kind into an envelope-safe enum token. Kinds are
 * already lowercase snake_case today; this is defense in depth so a future
 * kind can never be rejected at the envelope (or leak free-form text).
 */
export function attemptOutcomeToken(kind: string): string {
  const lowered = kind.toLowerCase().replace(/[^a-z0-9_.:-]/gu, '_').slice(0, 64);
  if (ENUM_TOKEN.test(lowered)) return lowered;
  return `outcome_${lowered}`.slice(0, 64).replace(/[^a-z0-9_.:-]/gu, '_');
}

export interface LifecycleEmitInput {
  lane: LifecycleLane;
  origin_lane?: LifecycleLane;
  work_id: string;
  phase: LifecyclePhase;
  correlation?: LifecycleEvent['correlation'];
  attrs?: LifecycleEvent['attrs'];
}

export interface LifecycleEmitter {
  /** False in phase `off`: emit() is a no-op and no store file exists. */
  readonly enabled: boolean;
  /** The per-process boot id stamped on every event from this emitter. */
  readonly bootId: string;
  /** Append one event. Returns true iff the store accepted it. NEVER throws. */
  emit(input: LifecycleEmitInput): boolean;
  close(): void;
}

export interface LifecycleEmitterOptions {
  phase: FleetLifecyclePhase;
  storePath: string;
  instance: string;
  host?: string;
  bootId?: string;
  /** Monotonic clock in ms (fractional ok). Default performance.now. */
  monotonicNow?: () => number;
  /** Wall clock (epoch ms) for at_utc and store retention. Default systemClock. */
  nowEpochMs?: () => number;
  /** Injectable store (tests). Default: lazily opened at storePath on first emit. */
  store?: LifecycleEventStore;
}

// Fail-closed gate: only these EXACT phases emit. An undefined, malformed, or
// future-unknown phase value must resolve to inert, never to emitting.
const EMITTING_PHASES: readonly FleetLifecyclePhase[] = ['shadow', 'alerting', 'default'];

export function createLifecycleEmitter(options: LifecycleEmitterOptions): LifecycleEmitter {
  const enabled = (EMITTING_PHASES as readonly unknown[]).includes(options.phase);
  const bootId = options.bootId ?? randomUUID();
  const host = options.host ?? hostname();
  const monotonicNow = options.monotonicNow ?? ((): number => performance.now());
  const nowEpochMs = options.nowEpochMs ?? ((): number => systemClock.now());

  let store: LifecycleEventStore | null = options.store ?? null;
  let storeBroken = false;

  function openStore(): LifecycleEventStore | null {
    if (store !== null || storeBroken) return store;
    try {
      store = createLifecycleEventStore({ path: options.storePath, nowEpochMs });
    } catch {
      // Observer-must-not-break-runtime: an unopenable store disables
      // emission for this process instead of throwing into the caller.
      storeBroken = true;
    }
    return store;
  }

  return {
    enabled,
    bootId,

    emit(input) {
      if (!enabled) return false;
      try {
        const target = openStore();
        if (target === null) return false;
        const event: LifecycleEvent = {
          schema: 'whatsoup.lifecycle.event.v1',
          instance: options.instance,
          host,
          lane: input.lane,
          origin_lane: input.origin_lane ?? null,
          work_id: input.work_id,
          correlation: input.correlation ?? {},
          phase: input.phase,
          at_utc: new Date(nowEpochMs()).toISOString(),
          boot_id: bootId,
          mono_ms: Math.round(monotonicNow()),
          attrs: input.attrs ?? {},
        };
        return target.append(event).accepted;
      } catch {
        return false;
      }
    },

    close() {
      try {
        store?.close();
      } catch {
        // Closing a broken store must not throw either.
      }
      store = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime singleton — the accessor the hook sites call. This DOMAIN module
// carries no config knowledge (ring boundary): the composition-facing caller
// (AgentRuntime's constructor, whose config import is an existing edge)
// initializes it. Until initialized, the singleton is inert.

const INERT_OPTIONS: LifecycleEmitterOptions = { phase: 'off', storePath: '', instance: 'unknown' };

let runtimeEmitter: LifecycleEmitter | null = null;
let inertFallback: LifecycleEmitter | null = null;

export function runtimeLifecycleEmitter(): LifecycleEmitter {
  if (runtimeEmitter !== null) return runtimeEmitter;
  inertFallback ??= createLifecycleEmitter(INERT_OPTIONS);
  return inertFallback;
}

/**
 * Initialize the runtime singleton once (first caller wins; later calls are
 * no-ops returning the existing emitter). `build` is evaluated inside the
 * fail-closed boundary: if it or the construction throws (e.g. a partial
 * test config with no dataRoot), the singleton latches INERT — never a
 * throw into the caller.
 */
export function initializeRuntimeLifecycleEmitter(build: () => LifecycleEmitterOptions): LifecycleEmitter {
  if (runtimeEmitter === null) {
    try {
      runtimeEmitter = createLifecycleEmitter(build());
    } catch {
      runtimeEmitter = createLifecycleEmitter(INERT_OPTIONS);
    }
  }
  return runtimeEmitter;
}

/** Test hook: inject a capturing emitter (null restores uninitialized/inert). */
export function __setRuntimeLifecycleEmitterForTests(emitter: LifecycleEmitter | null): void {
  runtimeEmitter = emitter;
}
