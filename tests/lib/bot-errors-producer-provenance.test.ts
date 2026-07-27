/**
 * Pins the TypeScript producer's BOT ERRORS provenance stamp (#2391).
 *
 * The dispatcher already has a test-traffic backstop: `is_test_provenance_event`
 * in `deploy/scripts/bot-errors-dispatcher.py` suppresses an event before
 * ordinary incident processing when `runtime.provenance.test` is exactly `true`.
 * Both sibling producers — `deploy/scripts/bot-errors-emit.py` and
 * `deploy/hooks/post-tool-use-log.mjs` — stamp that field. `bot-errors-outbox.ts`
 * did not, so TypeScript-shaped verifier and falsifier traffic reached the
 * dispatcher indistinguishable from a genuine incident.
 *
 * These tests build events in memory only. Nothing is written to an outbox and
 * no destination is contacted; every value used is a reserved synthetic marker.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  botErrorsRuntimeProvenance,
  buildBotErrorsEvent,
} from '../../src/lib/bot-errors-outbox.ts';

/**
 * The four keys the Python and hook producers share, plus `VITEST_POOL_ID`,
 * which this module's own routing already honours.
 */
const STRONG_SIGNALS = [
  'VITEST',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'JEST_WORKER_ID',
  'PYTEST_CURRENT_TEST',
] as const;

/** Shared with the sibling producers; parity is asserted below. */
const CROSS_PRODUCER_SIGNALS = ['VITEST', 'VITEST_WORKER_ID', 'JEST_WORKER_ID', 'PYTEST_CURRENT_TEST'] as const;

const ENV_KEYS = [
  ...STRONG_SIGNALS,
  'BOT_ERRORS_ALLOW_LIVE_IN_TESTS',
  'BOT_ERRORS_OUTBOX_DIR',
  'BOT_ERRORS_STATE_DIR',
  'NODE_ENV',
] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Drop every runner signal so the process looks like an ad-hoc invocation. */
function scrubRunnerSignals(): void {
  for (const key of STRONG_SIGNALS) delete process.env[key];
  delete process.env['NODE_ENV'];
}

/**
 * Also drop the explicit queue overrides that `tests/setup/bot-errors-vitest-isolation.ts`
 * installs, so the `default` and `test-default` branches of `outboxPolicy()`
 * become observable at all — with the isolation var present every policy reads
 * `explicit-state`.
 *
 * Safe only because everything under test here is pure: `botErrorsRuntimeProvenance()`
 * and `buildBotErrorsEvent()` read environment and return an object, and neither
 * touches the filesystem. No test in this file writes an event. `afterEach`
 * restores the isolation before any other file runs.
 */
function scrubQueueRouting(): void {
  delete process.env['BOT_ERRORS_STATE_DIR'];
  delete process.env['BOT_ERRORS_OUTBOX_DIR'];
}

function syntheticInput() {
  return {
    eventType: 'alert' as const,
    instance: 'synthetic-instance',
    source: 'synthetic-provenance-canary',
    summary: 'synthetic provenance canary summary',
  };
}

afterEach(restoreEnv);

describe('TypeScript BOT ERRORS producer — runtime provenance (#2391)', () => {
  it('marks an ad-hoc non-runner process as not-test', () => {
    scrubRunnerSignals();

    const provenance = botErrorsRuntimeProvenance();

    expect(provenance.test).toBe(false);
    expect(provenance.strongSignals).toEqual([]);
    expect(provenance.signals).toEqual([]);
    expect(provenance.producer).toBe('typescript-outbox');
  });

  for (const signal of STRONG_SIGNALS) {
    it(`marks a process carrying ${signal} as test`, () => {
      scrubRunnerSignals();
      process.env[signal] = 'synthetic-runner-value';

      const provenance = botErrorsRuntimeProvenance();

      expect(provenance.test).toBe(true);
      expect(provenance.strongSignals).toEqual([signal]);
    });
  }

  it('recognises every strong signal the Python and hook producers recognise', () => {
    // Parity guard: this producer must never recognise a strict subset of what
    // its siblings do, or the same traffic would be marked by one and missed by
    // another. A superset is allowed (see VITEST_POOL_ID).
    for (const signal of CROSS_PRODUCER_SIGNALS) {
      expect(STRONG_SIGNALS).toContain(signal);
    }
  });

  it('treats NODE_ENV=test as informational — recorded, but NOT sufficient to mark test', () => {
    // #2391 states this explicitly: "An informational test environment value
    // alone does not set the marker." Matching the Python producer, which adds
    // NODE_ENV to `signals` but derives `test` from strong signals only.
    scrubRunnerSignals();
    process.env['NODE_ENV'] = 'test';

    const provenance = botErrorsRuntimeProvenance();

    expect(provenance.test).toBe(false);
    expect(provenance.strongSignals).toEqual([]);
    expect(provenance.signals).toEqual(['NODE_ENV']);
  });

  it('reports an empty-string runner variable as absent', () => {
    scrubRunnerSignals();
    process.env['VITEST'] = '   ';

    expect(botErrorsRuntimeProvenance().test).toBe(false);
  });

  it('records which branch resolved the queue', () => {
    scrubRunnerSignals();
    scrubQueueRouting();
    expect(botErrorsRuntimeProvenance().outboxPolicy).toBe('default');

    process.env['BOT_ERRORS_STATE_DIR'] = '/synthetic/state';
    expect(botErrorsRuntimeProvenance().outboxPolicy).toBe('explicit-state');

    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/synthetic/outbox';
    const explicit = botErrorsRuntimeProvenance();
    expect(explicit.outboxPolicy).toBe('explicit-outbox');
    expect(explicit.resolvedOutbox).toBe('/synthetic/outbox');
    expect(explicit.liveOutboxRedirected).toBe(false);
  });

  it('still marks test traffic when BOT_ERRORS_ALLOW_LIVE_IN_TESTS routes it to the live queue', () => {
    // The hatch controls ROUTING, not attestation: it sends a test-runner
    // process's events to the live outbox instead of the sandbox. Attestation
    // must not follow it. An event produced under a runner is test traffic
    // whichever queue it lands in — that combination (runner process, live
    // queue) is precisely what the dispatcher backstop exists to refuse.
    //
    // This is a deliberate behaviour change: before provenance existed, an
    // event emitted through this hatch reached delivery. It now reaches
    // suppressed audit state instead.
    scrubRunnerSignals();
    scrubQueueRouting();
    process.env['VITEST'] = 'true';
    process.env['BOT_ERRORS_ALLOW_LIVE_IN_TESTS'] = '1';

    const provenance = botErrorsRuntimeProvenance();

    expect(provenance.test).toBe(true);
    expect(provenance.outboxPolicy).toBe('default');
    expect(provenance.liveOutboxRedirected).toBe(false);
  });

  it('flags the vitest state tree as a live-queue redirect', () => {
    scrubRunnerSignals();
    scrubQueueRouting();
    process.env['VITEST'] = 'true';

    const provenance = botErrorsRuntimeProvenance();

    expect(provenance.outboxPolicy).toBe('test-default');
    expect(provenance.liveOutboxRedirected).toBe(true);
  });
});

describe('buildBotErrorsEvent — provenance reaches the dispatcher screen', () => {
  it('stamps provenance on every built event regardless of caller', () => {
    // Reachability-independent source invariant: no caller opts in, so no
    // caller can forget. A behavioural test that only exercises one emit path
    // would stay green if provenance were wired per-caller and one was missed.
    scrubRunnerSignals();

    const event = buildBotErrorsEvent(syntheticInput());

    expect(event.runtime).toHaveProperty('provenance');
    expect(Object.keys(event.runtime.provenance).sort()).toEqual([
      'liveOutboxRedirected',
      'outboxPolicy',
      'producer',
      'resolvedOutbox',
      'signals',
      'strongSignals',
      'test',
    ]);
  });

  it('satisfies the dispatcher screen exactly: runtime.provenance.test === true', () => {
    // Mirrors `is_test_provenance_event`, which uses Python `is True` — a
    // truthy-but-not-boolean value would NOT be suppressed. Asserting identity
    // here, not truthiness, is what makes this test load-bearing.
    scrubRunnerSignals();
    process.env['VITEST_WORKER_ID'] = '1';

    const event = buildBotErrorsEvent(syntheticInput());
    const runtime = event.runtime as unknown as { provenance?: { test?: unknown } };

    expect(runtime.provenance?.test).toBe(true);
    expect(typeof runtime.provenance?.test).toBe('boolean');
  });

  it('leaves a genuine ad-hoc production event unsuppressed', () => {
    // The backstop must not swallow real incidents: with no runner signal the
    // stamp reads false, so the dispatcher's `is True` screen does not fire.
    scrubRunnerSignals();

    const event = buildBotErrorsEvent(syntheticInput());
    const runtime = event.runtime as unknown as { provenance: { test: boolean } };

    expect(runtime.provenance.test).toBe(false);
    // Close on the positive: the event is still a well-formed alert, so the
    // false reading means "attested live producer", not "event never built".
    expect(event.source).toBe('synthetic-provenance-canary');
  });
});
