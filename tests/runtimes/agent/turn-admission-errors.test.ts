// #3374/#3295 family — admission-rejection diagnosability (2026-08-29 q DM
// wedge). Every pre-dispatch admission throw was a bare `new Error`, and the
// log sanitizer reduces errors to `{errorClass}` — so a wedged scope logged
// `errorClass:"Error"` for two hours and the throw site could not be
// identified post-hoc (in-memory state destroyed by the recovering restart).
// These tests pin the fix: TYPED admission errors whose class names survive
// the sanitizer, plus a structured rejection log carrying the FIFO head.
import { describe, expect, it, vi } from 'vitest';

import {
  PerChatTurnFifoOwnerConflictError,
  ScopeBlockedByDurableRecoveryError,
  ScopeBlockedByFinalizationRecoveryError,
  admissionRejectionLogFields,
} from '../../../src/runtimes/agent/turn-admission-errors.ts';
import { sanitizeLogValue } from '../../../src/lib/log-sanitizer.ts';
import { RuntimeTurnCoordinator, type RuntimeTurnCoordinatorPort } from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

function context() {
  return createRuntimeTurnContext({
    identity: {
      scope: 'per_chat',
      conversationKey: '15550190099',
      deliveryJid: '15550190099@s.whatsapp.net',
      inboundSeq: 41,
      logicalTurnId: 'turn-admission-41',
      managerId: 'manager-admission',
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: 'turn-admission-41-recovery',
      managerId: 'manager-admission-recovery',
      generation: 1,
    },
    replay: {
      sourceMessageId: 'wamid-admission-41',
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

function queueStub() {
  return { beginTurnEvidence: vi.fn() } as never;
}

describe('typed admission errors survive the log sanitizer', () => {
  it('each class sanitizes to its own discriminating errorClass', () => {
    expect(sanitizeLogValue(new ScopeBlockedByDurableRecoveryError())).toEqual({
      errorClass: 'ScopeBlockedByDurableRecoveryError',
    });
    expect(sanitizeLogValue(new ScopeBlockedByFinalizationRecoveryError())).toEqual({
      errorClass: 'ScopeBlockedByFinalizationRecoveryError',
    });
    expect(sanitizeLogValue(new PerChatTurnFifoOwnerConflictError('key'))).toEqual({
      errorClass: 'PerChatTurnFifoOwnerConflictError',
    });
  });

  it('all three are Error subclasses (existing catch/instanceof paths unaffected)', () => {
    for (const err of [
      new ScopeBlockedByDurableRecoveryError(),
      new ScopeBlockedByFinalizationRecoveryError(),
      new PerChatTurnFifoOwnerConflictError('key'),
    ]) {
      expect(err).toBeInstanceOf(Error);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});

describe('beginRuntimeTurnEvidence throws typed admission errors', () => {
  it('durable-recovery block throws ScopeBlockedByDurableRecoveryError', () => {
    const host = {
      instanceName: 'admission-test',
      durability: { hasOutstandingTurnRecoveryForScope: vi.fn(() => true) },
      runtimeTurnSupervisor: { canAccept: vi.fn(() => true) },
    } as unknown as RuntimeTurnCoordinatorPort;
    const coordinator = new RuntimeTurnCoordinator(host);
    expect(() => coordinator.beginRuntimeTurnEvidence(queueStub(), context()))
      .toThrow(ScopeBlockedByDurableRecoveryError);
  });

  it('supervisor canAccept refusal throws ScopeBlockedByFinalizationRecoveryError', () => {
    const host = {
      instanceName: 'admission-test',
      durability: undefined,
      runtimeTurnSupervisor: { canAccept: vi.fn(() => false) },
    } as unknown as RuntimeTurnCoordinatorPort;
    const coordinator = new RuntimeTurnCoordinator(host);
    expect(() => coordinator.beginRuntimeTurnEvidence(queueStub(), context()))
      .toThrow(ScopeBlockedByFinalizationRecoveryError);
  });
});

describe('admissionRejectionLogFields — the datum the 2026-08-29 forensics lacked', () => {
  it('carries the rejection class, the FIFO head identity, and the turn identity', () => {
    const fields = admissionRejectionLogFields(
      'chat@lid',
      context(),
      new ScopeBlockedByFinalizationRecoveryError(),
      'stale-head-turn-id',
    );
    expect(fields).toEqual({
      mapKey: 'chat@lid',
      inboundSeq: 41,
      logicalTurnId: 'turn-admission-41',
      rejectionClass: 'ScopeBlockedByFinalizationRecoveryError',
      fifoHeadTurnId: 'stale-head-turn-id',
    });
  });

  it('reports an empty FIFO explicitly (empty vs stale-head is the H3 discriminator)', () => {
    const fields = admissionRejectionLogFields('chat@lid', context(), new Error('x'), undefined);
    expect(fields.fifoHeadTurnId).toBe('none');
    expect(fields.rejectionClass).toBe('Error');
  });
});
