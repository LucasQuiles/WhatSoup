import { describe, expect, it, vi } from 'vitest';
import { runNewCommand } from '../../../src/runtimes/agent/runtime-new-command.ts';

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
