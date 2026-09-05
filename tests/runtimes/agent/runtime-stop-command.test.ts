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
import { runStopCommand, type StopOutcome } from '../../../src/runtimes/agent/runtime-stop-command.ts';
import { classifyInput } from '../../../src/runtimes/agent/commands.ts';
import { COMMAND_REGISTRY, getCommandSpec } from '../../../src/runtimes/agent/command-registry.ts';

type SessionScope = 'single' | 'shared' | 'per_chat';

const NEVER_SETTLES = new Promise<never>(() => {});

function makeStopHarness(options: {
  inFlight: boolean;
  /** In-flight reading AFTER the teardown sequence. Defaults to false (idle). */
  inFlightAfterTeardown?: boolean;
  poisoned?: boolean;
  sessionScope?: SessionScope;
  /** Make terminalizeTurnForInterrupt reject with this error. */
  terminalizeError?: Error;
  /** Make terminalizeTurnForInterrupt never settle, forcing the bounded wait. */
  terminalizeHangs?: boolean;
  teardownTimeoutMs?: number;
}) {
  const sentTexts: string[] = [];
  const sessionScope = options.sessionScope ?? 'per_chat';
  let teardownRan = false;
  const inFlight = vi.fn(() => (teardownRan ? (options.inFlightAfterTeardown ?? false) : options.inFlight));
  const terminalizeTurnForInterrupt = vi.fn(async () => {
    if (options.terminalizeError) throw options.terminalizeError;
    if (options.terminalizeHangs) await NEVER_SETTLES;
    teardownRan = true;
    return { disposition: sessionScope === 'per_chat' ? 'kill' : 'interruption' };
  });
  const args = {
    chatJid: 'test@s.whatsapp.net',
    sessionScope,
    scopeKey: '__global__',
    perChatMapKey: sessionScope === 'per_chat' ? 'test@s.whatsapp.net' : null,
    teardownTimeoutMs: options.teardownTimeoutMs ?? 20,
    isTurnInFlight: inFlight,
    isOutboundQueuePoisoned: vi.fn(() => options.poisoned ?? false),
    getPerChatSession: vi.fn(() => (sessionScope === 'per_chat' ? {} : undefined)),
    abortPerChatQueue: vi.fn(),
    disposePerChatSession: vi.fn(async () => {}),
    getSingleSession: vi.fn(() => (sessionScope === 'per_chat' ? null : {})),
    abortActiveQueue: vi.fn(),
    terminalizeTurnForInterrupt,
    retireTurnQueueAfterInterrupt: vi.fn(async () => {}),
    shutdownOperationTracker: vi.fn(),
    cleanupGlobalAutoCompactState: vi.fn(),
    shutdownSingleSession: vi.fn(async () => {}),
    clearSingleScopeRefs: vi.fn(),
    clearTurnHadVisibleOutput: vi.fn(),
    sendDirect: (text: string) => { sentTexts.push(text); },
  };
  return { args, sentTexts, terminalizeTurnForInterrupt, isTurnInFlight: inFlight };
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
