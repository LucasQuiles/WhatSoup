// Supervisor scope-block visibility (#3374 family). `block()` mutates the
// admission gate for a whole scope yet logged nothing — and a block set via
// markDegraded() has no retained record, so runRetries can never release it
// (restart-only). This suite pins the fix: each turn's first block AND the
// retry-exhaustion transition emit a structured warn carrying `cause`; a
// scope emptying logs the matching unblock line. `grep markDegraded tests/`
// was previously ZERO — the one-way-door path was fully untested.
//
// Assertions here see PRE-sanitizer field values (the logger module is
// mocked): in the real journal a phone-shaped scopeKey is partially
// redacted; logicalTurnId is the surviving join.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../../helpers/logger-mock.ts');
  return { createChildLogger: hoistedLoggerMock(hoisted).createChildLogger };
});
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { RuntimeTurnSupervisor } from '../../../src/runtimes/agent/runtime-turn-supervisor.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import { resetLoggerMock } from '../../helpers/logger-mock.ts';

function context(turnId = 'turn-vis-1') {
  return createRuntimeTurnContext({
    identity: {
      scope: 'per_chat',
      conversationKey: '15550190099',
      deliveryJid: '15550190099@s.whatsapp.net',
      inboundSeq: 7,
      logicalTurnId: turnId,
      managerId: 'manager-vis',
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: `${turnId}-recovery`,
      managerId: 'manager-vis-recovery',
      generation: 1,
    },
    replay: {
      sourceMessageId: `wamid-${turnId}`,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid: '15550190099@s.whatsapp.net',
      senderName: null,
      text: 'hello',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: '15550190099#session',
  });
}

function makeSupervisor() {
  return new RuntimeTurnSupervisor<unknown>('vis-test', () => null, () => {});
}

function blockWarns(): Array<Record<string, unknown>> {
  const warn = hoisted['warn'] as ReturnType<typeof vi.fn>;
  return warn.mock.calls
    .filter(([, msg]) => typeof msg === 'string' && msg.includes('scope admission blocked'))
    .map(([fields]) => fields as Record<string, unknown>);
}

describe('supervisor scope-block visibility', () => {
  beforeEach(() => {
    resetLoggerMock(hoisted);
  });

  it('markDegraded blocks the scope AND logs a structured warn with cause degraded', () => {
    const supervisor = makeSupervisor();
    const ctx = context();
    supervisor.markDegraded(ctx);
    expect(supervisor.canAccept(ctx)).toBe(false);
    const warns = blockWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      scopeKey: 'per_chat:15550190099',
      logicalTurnId: 'turn-vis-1',
      cause: 'degraded',
    });
    supervisor.close();
  });

  it('a repeat block of the same turn does not re-log (no log storm per rejection)', () => {
    const supervisor = makeSupervisor();
    const ctx = context();
    supervisor.markDegraded(ctx);
    supervisor.markDegraded(ctx);
    expect(blockWarns()).toHaveLength(1);
    supervisor.close();
  });

  it('documents the one-way door: retryAll never releases a markDegraded block', async () => {
    const supervisor = makeSupervisor();
    const ctx = context();
    supervisor.markDegraded(ctx);
    await supervisor.retryAll();
    await supervisor.retryAll();
    expect(supervisor.canAccept(ctx)).toBe(false);
    expect(supervisor.health().degradedScopes).toBe(1);
    supervisor.close();
  });
});
