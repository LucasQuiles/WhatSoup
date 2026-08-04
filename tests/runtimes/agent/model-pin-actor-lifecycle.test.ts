import { describe, expect, it, vi } from 'vitest';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import {
  applyRouteChangeAndRecycle,
  recycleLiveSession,
  type ModelPinPort,
} from '../../../src/runtimes/agent/model-pin.ts';
import type { SessionManager } from '../../../src/runtimes/agent/session.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function makeHarness(
  childStopped: Promise<void>,
  turnTerminalized: Promise<void> = Promise.resolve(),
): {
  port: ModelPinPort;
  session: SessionManager;
  order: string[];
  releaseProofs: Promise<void>[];
} {
  const order: string[] = [];
  const releaseProofs: Promise<void>[] = [];
  const session = {
    shutdown: vi.fn(() => {
      order.push('shutdown');
      return childStopped;
    }),
    getProviderId: vi.fn(() => 'codex-cli'),
    getModelRef: vi.fn(() => 'old-model'),
  } as unknown as SessionManager;
  const queue = {
    abortTurn: vi.fn(() => order.push('abort')),
  } as unknown as IOutboundQueue;
  const port = {
    sessionScope: 'per_chat',
    chatSessions: new Map([['chat', session]]),
    chatQueues: new Map([['chat', queue]]),
    pendingRecycle: new Set<string>(),
    runtimeTurnCoordinator: {
      terminalizePerChatTurnQueueForKill: vi.fn(() => {
        order.push('terminalize');
        return turnTerminalized;
      }),
      retirePerChatTurnQueueAfterKill: vi.fn(() => {
        order.push('retire');
        return Promise.resolve();
      }),
    },
    deleteOwnedPerChatSession: vi.fn(() => {
      order.push('detach');
      return true;
    }),
    cleanupPerChatState: vi.fn((_mapKey: string, options?: { preserveActorSocket?: boolean }) => {
      order.push(options?.preserveActorSocket ? 'cleanup-preserved' : 'cleanup-released');
    }),
    retirePerChatProviderTransitionAfter: vi.fn((_mapKey: string, proof: Promise<void>) => {
      order.push('release-after');
      releaseProofs.push(proof);
    }),
    resolveRouteForTurn: vi.fn(() => ({
      provider: 'anthropic-api',
      model: 'new-model',
    })),
    isTurnInFlight: vi.fn(() => false),
  } as unknown as ModelPinPort;
  return { port, session, order, releaseProofs };
}

describe('model-pin per-chat actor lifecycle', () => {
  it('starts child shutdown and registers its proof before detaching the live owner', async () => {
    const child = deferred();
    const { port, session, order, releaseProofs } = makeHarness(child.promise);

    recycleLiveSession(port, 'chat', session);

    expect(session.shutdown).toHaveBeenCalledWith(false);
    expect(order.indexOf('shutdown')).toBeLessThan(order.indexOf('release-after'));
    // fail-closed contract: detach fires ONLY after childStopped resolves.
    // At this point (synchronous), detach MUST NOT have fired yet.
    // fail-closed: cleanup and detach fire ONLY after childStopped resolves.
    expect(order).not.toContain('cleanup-preserved');
    expect(order).not.toContain('detach');
    let stopped = false;
    void releaseProofs[0]!.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    child.resolve();
    await releaseProofs[0];
    expect(stopped).toBe(true);
    // After childStopped resolves successfully: cleanup and detach must fire.
    expect(order).toContain('cleanup-preserved');
    expect(order).toContain('detach');
  });

  it('passes a rejected child-stop proof through the generic transition barrier', async () => {
    const child = deferred();
    const { port, session, releaseProofs } = makeHarness(child.promise);

    recycleLiveSession(port, 'chat', session);
    child.reject(new Error('provider child still live'));

    await expect(releaseProofs[0]).rejects.toThrow(/still live/i);
    // fail-closed: on rejection, no cleanup, no detach — ownership retained.
    expect(port.cleanupPerChatState).not.toHaveBeenCalled();
    expect(port.deleteOwnedPerChatSession).not.toHaveBeenCalled();
  });

  it('uses the same child-stop barrier when a CLI route is replaced by an API route', async () => {
    const child = deferred();
    const { port, session, order, releaseProofs } = makeHarness(child.promise);

    // Do NOT await — the async path includes childStopped which resolves
    // only when child is resolved below. Call then await after resolving.
    const outcomePromise = applyRouteChangeAndRecycle(port, 'chat', 'actor', 'chat');

    // Synchronous assertions: barrier registered, session/route reflect old state.
    expect(session.getProviderId()).toBe('codex-cli');
    expect(port.resolveRouteForTurn('chat', 'actor').provider).toBe('anthropic-api');
    // detach fires inside childStopped.then() — not yet called at this point.
    expect(order).not.toContain('detach');
    let transitionReady = false;
    void releaseProofs[0]!.then(() => { transitionReady = true; });
    await Promise.resolve();
    expect(transitionReady).toBe(false);

    child.resolve();
    await releaseProofs[0];
    expect(transitionReady).toBe(true);
    const outcome = await outcomePromise;
    expect(outcome).toBe('recycled');
  });

  it('keeps replacement blocked until both child stop and turn terminalization settle', async () => {
    const child = deferred();
    const terminalization = deferred();
    const { port, session, releaseProofs } = makeHarness(
      child.promise,
      terminalization.promise,
    );

    recycleLiveSession(port, 'chat', session);
    child.resolve();
    let transitionReady = false;
    void releaseProofs[0]!.then(() => { transitionReady = true; });
    await Promise.resolve();
    expect(transitionReady).toBe(false);

    terminalization.resolve();
    await releaseProofs[0];
    expect(transitionReady).toBe(true);
  });

  it('keeps replacement fail-closed when turn terminalization rejects', async () => {
    const terminalization = deferred();
    const { port, session, releaseProofs } = makeHarness(
      Promise.resolve(),
      terminalization.promise,
    );

    recycleLiveSession(port, 'chat', session);
    terminalization.reject(new Error('turn ownership unresolved'));

    await expect(releaseProofs[0]).rejects.toThrow(/ownership unresolved/i);
  });
});
