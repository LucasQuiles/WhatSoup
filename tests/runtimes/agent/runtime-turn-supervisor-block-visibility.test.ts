// Supervisor scope-block visibility (#3374 family). `block()` mutates the
// admission gate for a whole scope yet logs nothing — and a block set via
// markDegraded() has no retained record, so runRetries can never release it
// (restart-only). This suite pins the fix: every block emits a structured
// warn whose `recoverable` field distinguishes retained (sweep-recoverable)
// blocks from markDegraded one-way blocks; `grep markDegraded tests/` was
// previously ZERO — the one-way-door path was fully untested.
import { describe, expect, it, vi } from 'vitest';

const warns = vi.hoisted(() => [] as Array<[Record<string, unknown>, string]>);
vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    warn: (obj: Record<string, unknown>, msg: string) => { warns.push([obj, msg]); },
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { RuntimeTurnSupervisor } from '../../../src/runtimes/agent/runtime-turn-supervisor.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';

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

describe('supervisor scope-block visibility', () => {
  it('markDegraded blocks the scope AND logs a structured warn marked unrecoverable', () => {
    warns.length = 0;
    const supervisor = makeSupervisor();
    const ctx = context();
    supervisor.markDegraded(ctx);
    expect(supervisor.canAccept(ctx)).toBe(false);
    const blockWarns = warns.filter(([, msg]) => msg.includes('scope admission blocked'));
    expect(blockWarns).toHaveLength(1);
    const [fields] = blockWarns[0]!;
    expect(fields['scopeKey']).toBe('per_chat:15550190099');
    expect(fields['logicalTurnId']).toBe('turn-vis-1');
    expect(fields['recoverable']).toBe(false);
  });

  it('a repeat block of the same turn does not re-log (no log storm per rejection)', () => {
    warns.length = 0;
    const supervisor = makeSupervisor();
    const ctx = context();
    supervisor.markDegraded(ctx);
    supervisor.markDegraded(ctx);
    expect(warns.filter(([, msg]) => msg.includes('scope admission blocked'))).toHaveLength(1);
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
