import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { SessionManager } from '../../../src/runtimes/agent/session.ts';
import {
  dispatchProviderFailureResult,
  type ProviderFailureResultContext,
  type RuntimeResultHandlerPort,
} from '../../../src/runtimes/agent/runtime-turn-result-handler.ts';

const emitAlertChecked = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked,
  emitAlert: vi.fn(() => ({ status: 'durably_queued' })),
  clearAlertSourceChecked: vi.fn(() => true),
}));

function makeCtx(providerText: string): ProviderFailureResultContext & {
  queue: { enqueueText: ReturnType<typeof vi.fn> };
  session: { shutdown: ReturnType<typeof vi.fn> };
} {
  return {
    queue: { enqueueText: vi.fn(), targetChatJid: '15550190077@s.whatsapp.net' } as unknown as IOutboundQueue,
    session: { shutdown: vi.fn(async () => {}) } as unknown as SessionManager,
    providerText,
    turnHadToolWork: false,
    logChatJid: '15550190077@s.whatsapp.net',
    cleanupArgs: {},
    recordTurnFailure: vi.fn(),
  } as never;
}

const host = { instanceName: 'test-bot' } as unknown as RuntimeResultHandlerPort;

describe('context-overflow kill path emits a fleet-visible alert', () => {
  beforeEach(() => {
    emitAlertChecked.mockClear();
  });

  it('emits provider_context_overflow (warning) before killing the session', () => {
    const ctx = makeCtx('Error: prompt is too long for the context window');
    dispatchProviderFailureResult(host, ctx);
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);
    const [instance, source, , , severity] = emitAlertChecked.mock.calls[0]!;
    expect(instance).toBe('test-bot');
    expect(source).toBe('provider_context_overflow');
    expect(severity).toBe('warning');
    // Existing behavior must be preserved: notice + kill.
    expect((ctx.queue as unknown as { enqueueText: ReturnType<typeof vi.fn> }).enqueueText).toHaveBeenCalled();
    expect((ctx.session as unknown as { shutdown: ReturnType<typeof vi.fn> }).shutdown).toHaveBeenCalled();
  });

  it('does NOT emit for the policy-block kill path (overflow-specific signal)', () => {
    const ctx = makeCtx('This request violates our policy.');
    dispatchProviderFailureResult(host, ctx);
    expect(emitAlertChecked).not.toHaveBeenCalled();
  });
});
