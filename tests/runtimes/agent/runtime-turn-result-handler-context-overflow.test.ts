import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { SessionManager } from '../../../src/runtimes/agent/session.ts';
import {
  dispatchProviderFailureResult,
  type ProviderFailureResultContext,
  type RuntimeResultHandlerPort,
} from '../../../src/runtimes/agent/runtime-turn-result-handler.ts';

const emitAlertChecked = vi.hoisted(() => vi.fn((..._args: unknown[]) => true));
const emitObservationChecked = vi.hoisted(() => vi.fn((..._args: unknown[]) => true));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked,
  emitObservationChecked,
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

describe('context-overflow kill path emits one-shot fleet telemetry', () => {
  beforeEach(() => {
    emitAlertChecked.mockClear();
    emitObservationChecked.mockClear();
  });

  it('emits a provider_context_overflow OBSERVATION (no incident lifecycle) before killing the session', () => {
    const ctx = makeCtx('Error: prompt is too long for the context window');
    dispatchProviderFailureResult(host, ctx, () => null);
    // Observation, not alert: the kill self-recovers on the next message, so
    // alert telemetry would open an incident nothing ever clears (2026-08-25
    // follow-up audit) and join the still-open renotify carpet.
    expect(emitObservationChecked).toHaveBeenCalledTimes(1);
    const call = emitObservationChecked.mock.calls[0] as unknown[];
    expect(call[0]).toBe('test-bot');
    expect(call[1]).toBe('provider_context_overflow');
    expect(emitAlertChecked).not.toHaveBeenCalled();
    // Existing behavior must be preserved: notice + kill.
    expect((ctx.queue as unknown as { enqueueText: ReturnType<typeof vi.fn> }).enqueueText).toHaveBeenCalled();
    expect((ctx.session as unknown as { shutdown: ReturnType<typeof vi.fn> }).shutdown).toHaveBeenCalled();
  });

  it('does NOT emit for the policy-block kill path (overflow-specific signal)', () => {
    const ctx = makeCtx('This request violates our policy.');
    dispatchProviderFailureResult(host, ctx, () => null);
    expect(emitObservationChecked).not.toHaveBeenCalled();
    expect(emitAlertChecked).not.toHaveBeenCalled();
  });
});
