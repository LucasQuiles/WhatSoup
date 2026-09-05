// #2949 N1: /stop as a registered preemptive control.
//
// Sibling of runtime-new-command.test.ts and driven the same way: a
// closure-backed double host, so the outcome taxonomy is exercised without the
// session manager. Three outcomes, each with its OWN evidence, and never a
// false success:
//   stopped          — the teardown sequence completed AND the runtime's own
//                      in-flight resolver reports the scope idle afterwards.
//   nothing-to-stop  — no active turn at entry.
//   uncertain        — teardown was requested but not PROVEN: a step threw, the
//                      bounded wait elapsed, the scope still reads in flight, or
//                      delivery is poisoned.
//
// The uncertain drivers are deliberately independent of session scope. The
// teardown transaction's `disposition` field is NOT an outcome signal here: it
// is assigned unconditionally by which coordinator method ran
// (runtime-turn-coordinator.ts:1353 'interruption' for global,
// :1542 'kill' for per-chat), so keying an outcome off it would report a
// function of scope while claiming to report proof.

import { describe, expect, it, vi } from 'vitest';
import {
  runStopCommand,
  isStopTeardownInFlight,
  type StopOutcome,
} from '../../../src/runtimes/agent/runtime-stop-command.ts';
import { classifyInput } from '../../../src/runtimes/agent/commands.ts';
import { COMMAND_REGISTRY, getCommandSpec } from '../../../src/runtimes/agent/command-registry.ts';

type SessionScope = 'single' | 'shared' | 'per_chat';

const NEVER_SETTLES = new Promise<never>(() => {});

/**
 * Distinct scopeKey per harness by default. The re-entrancy guard (item C) is
 * module state keyed by scopeKey, so a shared key would leak a held guard from
 * one case into the next — the guard cases pass an explicit shared key on
 * purpose.
 */
let harnessSeq = 0;

function makeStopHarness(options: {
  inFlight: boolean;
  /** In-flight reading AFTER the teardown sequence. Defaults to false (idle). */
  inFlightAfterTeardown?: boolean;
  poisoned?: boolean;
  sessionScope?: SessionScope;
  /** Share a scope with another harness to exercise the re-entrancy guard. */
  scopeKey?: string;
  /** Make terminalizeTurnForInterrupt reject with this error. */
  terminalizeError?: Error;
  /** Make terminalizeTurnForInterrupt never settle, forcing the bounded wait. */
  terminalizeHangs?: boolean;
  /** Hold the teardown open under the test's own control, then let it finish. */
  terminalizeGate?: Promise<unknown>;
  /** The runtime's termination proof for every torn-down session. */
  sessionProvablyTerminated?: boolean;
  /** Scope holds no session object to prove: the disclosed vacuous path. */
  noSessionToProve?: boolean;
  teardownTimeoutMs?: number;
}) {
  const sentTexts: string[] = [];
  const sessionScope = options.sessionScope ?? 'per_chat';
  const singleSession = { id: 'single-session' };
  const perChatSession = { id: 'per-chat-session' };
  let teardownRan = false;
  let scopeRefsCleared = false;
  const inFlight = vi.fn(() => (teardownRan ? (options.inFlightAfterTeardown ?? false) : options.inFlight));
  const terminalizeTurnForInterrupt = vi.fn(async () => {
    if (options.terminalizeError) throw options.terminalizeError;
    if (options.terminalizeGate) await options.terminalizeGate;
    if (options.terminalizeHangs) await NEVER_SETTLES;
    teardownRan = true;
    return { disposition: sessionScope === 'per_chat' ? 'kill' : 'interruption' };
  });
  const isSessionProvablyTerminated = vi.fn(() => options.sessionProvablyTerminated ?? true);
  const args = {
    chatJid: 'test@s.whatsapp.net',
    sessionScope,
    scopeKey: options.scopeKey ?? `scope-${++harnessSeq}`,
    perChatMapKey: sessionScope === 'per_chat' ? 'test@s.whatsapp.net' : null,
    teardownTimeoutMs: options.teardownTimeoutMs ?? 20,
    isTurnInFlight: inFlight,
    isOutboundQueuePoisoned: vi.fn(() => options.poisoned ?? false),
    isSessionProvablyTerminated,
    getPerChatSession: vi.fn(() => (
      sessionScope === 'per_chat' && options.noSessionToProve !== true ? perChatSession : undefined
    )),
    abortPerChatQueue: vi.fn(),
    disposePerChatSession: vi.fn(async () => {}),
    // Mirrors the runtime binding: `getSingleSession` reads `this.session`,
    // which `clearSingleScopeRefs` nulls. A proof read AFTER the teardown would
    // therefore be handed null and pass vacuously.
    getSingleSession: vi.fn(() => (
      sessionScope === 'per_chat' || scopeRefsCleared || options.noSessionToProve === true
        ? null
        : singleSession
    )),
    abortActiveQueue: vi.fn(),
    terminalizeTurnForInterrupt,
    retireTurnQueueAfterInterrupt: vi.fn(async () => {}),
    shutdownOperationTracker: vi.fn(),
    cleanupGlobalAutoCompactState: vi.fn(),
    shutdownSingleSession: vi.fn(async () => {}),
    clearSingleScopeRefs: vi.fn(() => { scopeRefsCleared = true; }),
    clearTurnHadVisibleOutput: vi.fn(),
    sendDirect: (text: string) => { sentTexts.push(text); },
  };
  return {
    args,
    sentTexts,
    terminalizeTurnForInterrupt,
    isTurnInFlight: inFlight,
    isSessionProvablyTerminated,
    singleSession,
    perChatSession,
  };
}

async function run(harness: { args: unknown }): Promise<StopOutcome> {
  return runStopCommand(harness.args as never);
}

// ─── Registration: /stop is a control, not ordinary text ─────────────────────

describe('#2949 N1: /stop is a registered local control', () => {
  it('the registry carries a /stop entry as a transport-local command', () => {
    expect([...COMMAND_REGISTRY].map((c) => c.name)).toContain('stop');
    const spec = getCommandSpec('stop' as never);
    expect(spec.tier).toBe('transport-local');
    // Same blast radius as /new: stopping the active turn hits SHARED session
    // state in single/shared scope and in a per_chat group (WG-5).
    expect(spec.gate).toBe('admin-shared-scope');
    expect(spec.visibility).toBe('end-user');
  });

  it('classifies /stop as local, never as forwarded text', () => {
    expect(classifyInput('/stop')).toEqual({ type: 'local', command: 'stop' });
    expect(classifyInput('/STOP')).toEqual({ type: 'local', command: 'stop' });
    expect(classifyInput('/stop ')).toEqual({ type: 'local', command: 'stop' });
  });

  it('classification is turn-state independent — the same reading mid-turn as idle', () => {
    // classifyInput is a pure function of (text, routingAliases): it takes no
    // turn state, so a mid-turn /stop cannot classify differently from an idle
    // one. The runtime-level mid-turn no-forward proof lives in
    // command-gate-contract.test.ts (it drives a hung provider turn).
    expect(classifyInput('/stop', { routingAliases: true }))
      .toEqual(classifyInput('/stop', { routingAliases: false }));
  });

  it('positive control: an unregistered slash command still forwards as text', () => {
    // Falsifies "every slash command classifies local" — without this the
    // /stop assertions above would pass against a broken classifier.
    expect(classifyInput('/stopwatch')).toEqual({ type: 'forwarded', text: '/stopwatch' });
  });
});

// ─── Outcome taxonomy ────────────────────────────────────────────────────────

describe('#2949 N1: runStopCommand reports exactly one durable outcome', () => {
  it('nothing-to-stop when no turn is in flight, and never runs a teardown', async () => {
    const harness = makeStopHarness({ inFlight: false });
    await expect(run(harness)).resolves.toBe('nothing-to-stop');

    expect(harness.terminalizeTurnForInterrupt).not.toHaveBeenCalled();
    expect(harness.sentTexts).toHaveLength(1);
    expect(harness.sentTexts[0]).toContain('Nothing to stop');
    expect(harness.sentTexts[0]).not.toContain('Stopped the running task');
    expect(harness.sentTexts[0]).not.toContain('uncertain');
  });

  it.each(['per_chat', 'single', 'shared'] as const)(
    'stopped in %s scope when teardown completes and the scope then reads idle',
    async (sessionScope) => {
      const harness = makeStopHarness({ inFlight: true, sessionScope });
      await expect(run(harness)).resolves.toBe('stopped');

      expect(harness.terminalizeTurnForInterrupt).toHaveBeenCalledOnce();
      expect(harness.sentTexts).toHaveLength(1);
      expect(harness.sentTexts[0]).toContain('Stopped the running task');
      expect(harness.sentTexts[0]).not.toContain('uncertain');
      // Proof is re-read from the runtime's OWN resolver after the teardown,
      // not assumed from the teardown call returning.
      expect(harness.isTurnInFlight).toHaveBeenCalledTimes(2);
    },
  );

  it('uncertain when the bounded wait elapses before teardown settles', async () => {
    const harness = makeStopHarness({ inFlight: true, terminalizeHangs: true, teardownTimeoutMs: 20 });
    await expect(run(harness)).resolves.toBe('uncertain');

    expect(harness.sentTexts).toHaveLength(1);
    expect(harness.sentTexts[0]).toContain('uncertain');
    // C4: never a false success acknowledgement.
    expect(harness.sentTexts[0]).not.toContain('Stopped the running task');
    expect(harness.sentTexts[0]).not.toContain('Nothing to stop');
  });

  it('uncertain when a teardown step throws', async () => {
    const harness = makeStopHarness({
      inFlight: true,
      terminalizeError: new Error('teardown exploded'),
    });
    await expect(run(harness)).resolves.toBe('uncertain');

    expect(harness.sentTexts).toHaveLength(1);
    expect(harness.sentTexts[0]).toContain('uncertain');
    expect(harness.sentTexts[0]).not.toContain('Stopped the running task');
  });

  it('uncertain when the scope still reads in flight after the teardown returned', async () => {
    const harness = makeStopHarness({ inFlight: true, inFlightAfterTeardown: true });
    await expect(run(harness)).resolves.toBe('uncertain');

    expect(harness.terminalizeTurnForInterrupt).toHaveBeenCalledOnce();
    expect(harness.sentTexts).toHaveLength(1);
    expect(harness.sentTexts[0]).toContain('uncertain');
    expect(harness.sentTexts[0]).not.toContain('Stopped the running task');
  });

  it('uncertain when delivery is poisoned even though the turn tore down', async () => {
    const harness = makeStopHarness({ inFlight: true, poisoned: true });
    await expect(run(harness)).resolves.toBe('uncertain');

    expect(harness.sentTexts).toHaveLength(1);
    expect(harness.sentTexts[0]).toContain('uncertain');
    expect(harness.sentTexts[0]).toContain('delivery');
    expect(harness.sentTexts[0]).not.toContain('Stopped the running task');
  });

});

// ─── A: 'stopped' requires the runtime's own termination proof ───────────────

describe("#2949 N1: 'stopped' requires every torn-down session to be provably terminated", () => {
  it.each(['per_chat', 'single', 'shared'] as const)(
    'uncertain in %s scope when a torn-down session is not provably terminated',
    async (sessionScope) => {
      const harness = makeStopHarness({
        inFlight: true,
        sessionScope,
        sessionProvablyTerminated: false,
      });
      await expect(run(harness)).resolves.toBe('uncertain');

      // The teardown DID run — this is an unproven teardown, not a skipped one.
      expect(harness.terminalizeTurnForInterrupt).toHaveBeenCalledOnce();
      expect(harness.sentTexts).toHaveLength(1);
      expect(harness.sentTexts[0]).toContain('could not be proven terminated');
      expect(harness.sentTexts[0]).toContain('uncertain');
      expect(harness.sentTexts[0]).not.toContain('Stopped the running task');
    },
  );

  it('single/shared: the proof reads the session captured BEFORE the refs were cleared', async () => {
    // clearSingleScopeRefs nulls the runtime's session ref. If the proof were
    // taken after the teardown it would be handed null, prove nothing, and this
    // case would report 'stopped'.
    const harness = makeStopHarness({
      inFlight: true,
      sessionScope: 'single',
      sessionProvablyTerminated: false,
    });
    await expect(run(harness)).resolves.toBe('uncertain');

    expect(harness.args.clearSingleScopeRefs).toHaveBeenCalledOnce();
    expect(harness.isSessionProvablyTerminated).toHaveBeenCalledWith(harness.singleSession);
  });

  it('per_chat: the proof reads the interrupted session, and a proven one still stops', async () => {
    const harness = makeStopHarness({ inFlight: true, sessionScope: 'per_chat' });
    await expect(run(harness)).resolves.toBe('stopped');

    expect(harness.isSessionProvablyTerminated).toHaveBeenCalledWith(harness.perChatSession);
    expect(harness.sentTexts[0]).toContain('Stopped the running task');
  });
});

// ─── B: the nothing-to-stop acknowledgement is scope-honest ──────────────────

describe('#2949 N1: nothing-to-stop tells the truth about the scope it ran in', () => {
  it('in SINGLE scope it discloses that a mid-task /stop is only seen afterwards', async () => {
    const harness = makeStopHarness({ inFlight: false, sessionScope: 'single' });
    await expect(run(harness)).resolves.toBe('nothing-to-stop');

    expect(harness.sentTexts).toHaveLength(1);
    // The discriminating clause — 'Nothing to stop' alone is in BOTH wordings,
    // so asserting only that would survive deleting this disclosure.
    expect(harness.sentTexts[0]).toContain('only seen after that task finishes');
    expect(harness.sentTexts[0]).toContain('cannot interrupt a task already in progress');
    expect(harness.terminalizeTurnForInterrupt).not.toHaveBeenCalled();
  });

  it.each(['per_chat', 'shared'] as const)(
    '%s keeps the plain wording — a mid-turn /stop reaches the teardown there',
    async (sessionScope) => {
      // shared enqueues the provider turn through enqueueSharedRuntimeTurn
      // without awaiting it (runtime.ts:4970-5012 at b65984f0), so turnChain is
      // free and a mid-turn /stop is handled while the task runs. Only single
      // runs the turn inline. Telling a shared user their /stop cannot interrupt
      // a running task would be false.
      const harness = makeStopHarness({ inFlight: false, sessionScope });
      await expect(run(harness)).resolves.toBe('nothing-to-stop');

      expect(harness.sentTexts).toHaveLength(1);
      expect(harness.sentTexts[0]).toContain('Nothing to stop');
      expect(harness.sentTexts[0]).not.toContain('only seen after that task finishes');
      expect(harness.sentTexts[0]).not.toContain('cannot interrupt a task already in progress');
    },
  );
});

// ─── C: a second /stop never re-enters a teardown in flight ──────────────────

describe('#2949 N1: the re-entrancy guard is per scopeKey', () => {
  it('a second /stop for the same scope answers already-stopping and runs no teardown', async () => {
    const scopeKey = 'guard-concurrent-scope';
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = makeStopHarness({
      inFlight: true, scopeKey, terminalizeGate: gate, teardownTimeoutMs: 5_000,
    });
    const firstRun = run(first);
    const second = makeStopHarness({ inFlight: true, scopeKey });

    await expect(run(second)).resolves.toBe('already-stopping');
    expect(second.terminalizeTurnForInterrupt).not.toHaveBeenCalled();
    expect(second.sentTexts).toHaveLength(1);
    expect(second.sentTexts[0]).toContain('Stop already in progress');
    expect(second.sentTexts[0]).not.toContain('Stopped the running task');

    release();
    await expect(firstRun).resolves.toBe('stopped');
  });

  it('a DIFFERENT scope is never blocked by another scope guard', async () => {
    // Positive control: without this, a guard that blocked every /stop
    // unconditionally would pass the case above.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = makeStopHarness({
      inFlight: true, scopeKey: 'guard-scope-a', terminalizeGate: gate, teardownTimeoutMs: 5_000,
    });
    const heldRun = run(held);
    const other = makeStopHarness({ inFlight: true, scopeKey: 'guard-scope-b' });

    await expect(run(other)).resolves.toBe('stopped');
    expect(other.terminalizeTurnForInterrupt).toHaveBeenCalledOnce();

    release();
    await heldRun;
  });

  it('the guard is released once the teardown settles, so a later /stop runs', async () => {
    const scopeKey = 'guard-sequential-scope';
    const first = makeStopHarness({ inFlight: true, scopeKey });
    await expect(run(first)).resolves.toBe('stopped');

    const second = makeStopHarness({ inFlight: true, scopeKey });
    await expect(run(second)).resolves.toBe('stopped');
    expect(second.terminalizeTurnForInterrupt).toHaveBeenCalledOnce();
  });

  it('the guard is HELD past a bounded-wait timeout while the teardown runs on', async () => {
    // The detached teardown still owns the coordinator state after the wait
    // elapsed, so a second /stop must not start a concurrent one.
    const scopeKey = 'guard-timeout-scope';
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = makeStopHarness({
      inFlight: true, scopeKey, terminalizeGate: gate, teardownTimeoutMs: 5,
    });
    await expect(run(first)).resolves.toBe('uncertain');
    expect(first.sentTexts[0]).toContain('did not complete in time');

    const second = makeStopHarness({ inFlight: true, scopeKey });
    await expect(run(second)).resolves.toBe('already-stopping');
    expect(second.terminalizeTurnForInterrupt).not.toHaveBeenCalled();

    release();
  });
});

// ─── L: the disclosed RESIDUAL, pinned so a change to it is deliberate ───────

describe('#2949 N1 RESIDUAL: an empty torn-down set satisfies the proof vacuously', () => {
  it.each(['single', 'per_chat'] as const)(
    'in %s scope with no session to prove, /stop reports stopped and never calls the proof',
    async (sessionScope) => {
      // Disclosed in the module header: the scope holds no session object to
      // interrogate, so the torn-down set is empty and the predicate is
      // vacuously satisfied. This is the CURRENT behaviour, pinned; changing it
      // must be a deliberate edit to this test, not a silent drift.
      const harness = makeStopHarness({ inFlight: true, sessionScope, noSessionToProve: true });
      await expect(run(harness)).resolves.toBe('stopped');

      expect(harness.terminalizeTurnForInterrupt).toHaveBeenCalledOnce();
      expect(harness.isSessionProvablyTerminated).not.toHaveBeenCalled();
      expect(harness.sentTexts[0]).toContain('Stopped the running task');
    },
  );
});

// ─── J: the guard state the /new refusal reads ──────────────────────────────

describe('#2949 N1: isStopTeardownInFlight fences the other command that re-enters the seam', () => {
  it('reads true while the teardown is unsettled, including past the bounded wait, and false after', async () => {
    const scopeKey = 'guard-query-scope';
    expect(isStopTeardownInFlight(scopeKey)).toBe(false);

    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = makeStopHarness({
      inFlight: true, scopeKey, terminalizeGate: gate, teardownTimeoutMs: 5,
    });
    await expect(run(held)).resolves.toBe('uncertain');

    // The bounded wait elapsed and the teardown detached — this is exactly the
    // window in which /new must not run the seam again.
    expect(isStopTeardownInFlight(scopeKey)).toBe(true);

    release();
    await vi.waitFor(() => expect(isStopTeardownInFlight(scopeKey)).toBe(false));
  });

  it('is scope-local: a teardown on one scope does not fence another', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = makeStopHarness({
      inFlight: true, scopeKey: 'guard-query-a', terminalizeGate: gate, teardownTimeoutMs: 5,
    });
    await expect(run(held)).resolves.toBe('uncertain');

    expect(isStopTeardownInFlight('guard-query-a')).toBe(true);
    expect(isStopTeardownInFlight('guard-query-b')).toBe(false);

    release();
  });
});
