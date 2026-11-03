import { describe, expect, it, vi } from 'vitest';
import { runNewCommand } from '../../../src/runtimes/agent/runtime-new-command.ts';
import { HandoffDistillRunner } from '../../../src/runtimes/agent/handoff-distill-runner.ts';
import type { DistillBudgetConfig } from '../../../src/runtimes/agent/handoff-distill-gate.ts';

type SessionScope = 'single' | 'shared' | 'per_chat';

function makeCommandHarness(options: {
  inFlight: boolean;
  poisoned?: boolean;
  sessionScope?: SessionScope;
  disposition?: 'kill' | 'interruption';
}) {
  let ackText = '';
  const sessionScope = options.sessionScope ?? 'per_chat';
  const isOutboundQueuePoisoned = vi.fn(() => options.poisoned ?? false);
  const args = {
    isTurnInFlight: vi.fn(() => options.inFlight),
    isOutboundQueuePoisoned,
    sessionScope,
    getPerChatSession: vi.fn(() => sessionScope === 'per_chat' ? {} : undefined),
    abortPerChatQueue: vi.fn(),
    terminalizeTurnForInterrupt: vi.fn(async () => options.disposition
      ? { disposition: options.disposition }
      : undefined),
    disposePerChatSession: vi.fn(),
    scopeKey: '__global__',
    perChatMapKey: sessionScope === 'per_chat' ? 'test@s.whatsapp.net' : null,
    sendDirect(text: string) { ackText = text; },
    getSingleSession: vi.fn(() => sessionScope === 'per_chat' ? null : {}),
    shutdownSingleSession: vi.fn(),
    retireTurnQueueAfterInterrupt: vi.fn(),
    abortActiveQueue: vi.fn(),
    shutdownOperationTracker: vi.fn(),
    cleanupGlobalAutoCompactState: vi.fn(),
    clearSingleScopeRefs: vi.fn(),
    clearHandoffLatches: vi.fn(),
    clearTurnHadVisibleOutput: vi.fn(),
    resetOwnedPerChatSession: vi.fn(),
    replaceOutboundQueue: vi.fn(),
    abortChatQueue: vi.fn(),
    resetSingleSession: vi.fn(),
    shared: false,
    sandboxPerChat: false,
    chatJid: 'test@s.whatsapp.net',
  };
  return { args, getAckText: () => ackText, isOutboundQueuePoisoned };
}

describe('runNewCommand recovery acknowledgements', () => {
  it('/new fences a deferred distill through the reset lifecycle before it can persist', async () => {
    let resolve!: (outcome: { summary: string; seededArtifacts: null; tokensUsed: number }) => void;
    const pending = new Promise<{ summary: string; seededArtifacts: null; tokensUsed: number }>((release) => {
      resolve = release;
    });
    const persist = vi.fn();
    const onSucceeded = vi.fn();
    const config: DistillBudgetConfig = {
      maxTokensPerWindow: 100_000,
      maxCallsPerWindow: 10,
      windowMs: 3_600_000,
      failureThreshold: 3,
      breakerCooldownMs: 60_000,
      globalConcurrency: 1,
    };
    const runner = new HandoffDistillRunner({
      config,
      now: () => 1_000,
      growthThreshold: 1,
      tokenGrowth: () => 2,
      distillFor: () => pending,
      persist,
      onDegraded: vi.fn(),
      onSucceeded,
      sourceFor: () => ({ provider: 'test-provider', model: 'test-model' }),
    });
    const harness = makeCommandHarness({ inFlight: false });
    harness.args.clearHandoffLatches.mockImplementation(() => runner.invalidateConversation('test@s.whatsapp.net'));

    const tick = runner.tickConversation('test@s.whatsapp.net');
    await runNewCommand(harness.args as never);
    resolve({ summary: 'stale after reset', seededArtifacts: null, tokensUsed: 1 });
    await tick;

    expect(harness.args.clearHandoffLatches).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  it('reports recovery pending when teardown disposition is kill', async () => {
    const harness = makeCommandHarness({ inFlight: true, disposition: 'kill' });
    await runNewCommand(harness.args as never);

    expect(harness.getAckText()).toContain('Interrupted the running task');
    expect(harness.getAckText()).toContain('recovery pending');
  });

  it('reports a new session when teardown disposition is interruption', async () => {
    const harness = makeCommandHarness({ inFlight: true, disposition: 'interruption' });
    await runNewCommand(harness.args as never);

    expect(harness.getAckText()).toContain('Interrupted the running task');
    expect(harness.getAckText()).not.toContain('recovery pending');
    expect(harness.getAckText()).toContain('starting new session');
  });

  it.each(['single', 'shared', 'per_chat'] as const)(
    'reports recovery pending when poison survives an idle %s reset',
    async (sessionScope) => {
      const harness = makeCommandHarness({ inFlight: false, poisoned: true, sessionScope });
      await runNewCommand(harness.args as never);

      expect(harness.getAckText()).toContain('recovery pending');
      expect(harness.getAckText()).toContain('delivery remains blocked');
      expect(harness.getAckText()).not.toContain('Starting new session');
      expect(harness.isOutboundQueuePoisoned).toHaveBeenCalledOnce();
    },
  );
});
