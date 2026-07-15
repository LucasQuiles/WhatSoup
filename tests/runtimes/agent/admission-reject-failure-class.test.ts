import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  type AttemptOutcome,
  type TurnTerminalResult,
} from '../../../src/runtimes/agent/turn-terminal.ts';

// #1750 — admission_rejected must subclass its distinct rejection reasons into
// distinct, durable failure_class values (queue full / halted / closed /
// pre-dispatch error / recovery-scope block) instead of collapsing every
// reject to 'unknown'. These tests exercise the FULL persistence path:
// toTurnFinalizationPersistence (agent mapper) -> normalizeFinalizeTurnTerminalParams
// (core contract cross-check) -> finalizeTurnTerminal -> markInboundFailed ->
// coerceInboundFailureClass. That proves the mapping AND the durable-vocabulary
// set membership in a single assertion — a stray value silently collapses to
// 'unknown' at the coerce gate, which this catches.

const IDENTITY = {
  scope: 'per_chat',
  conversationKey: 'conversation-admission',
  deliveryJid: '15550100001:7@s.whatsapp.net',
  logicalTurnId: 'turn-admission',
  managerId: 'manager-primary',
  generation: 2,
} as const;

function rejected(inboundSeq: number, admissionClass?: string): TurnTerminalResult {
  const attemptOutcome = (admissionClass === undefined
    ? { kind: 'admission_rejected' }
    : { kind: 'admission_rejected', class: admissionClass }) as AttemptOutcome;
  return {
    identity: { ...IDENTITY, inboundSeq },
    attemptOutcome,
    inboundDisposition: 'failed_terminal',
    deliveryEvidence: { kind: 'none' },
  };
}

describe('admission_rejected failure-class subclassing (#1750)', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  function finalizeRejection(admissionClass?: string): {
    inboundFailureClass: string | null;
    attemptFailureClass: string | null;
  } {
    const inboundSeq = durability.journalInbound(
      `message-${admissionClass ?? 'legacy'}`,
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    durability.finalizeTurnTerminal(
      toTurnFinalizationPersistence(rejected(inboundSeq, admissionClass)),
    );
    const inboundRow = db.raw
      .prepare('SELECT failure_class FROM inbound_events WHERE seq = ?')
      .get(inboundSeq) as { failure_class: string | null };
    const terminalRow = durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, IDENTITY.generation);
    return {
      inboundFailureClass: inboundRow.failure_class,
      attemptFailureClass: terminalRow?.attempt_failure_class ?? null,
    };
  }

  it.each([
    { admissionClass: 'queue_full', expected: 'queue_full' },
    { admissionClass: 'queue_halted', expected: 'queue_halted' },
    { admissionClass: 'queue_closed', expected: 'queue_closed' },
    { admissionClass: 'pre_dispatch_error', expected: 'pre_dispatch_error' },
    { admissionClass: 'scope_blocked_recovery', expected: 'scope_blocked_recovery' },
  ])(
    'stamps a distinct durable failure_class for admission class $admissionClass',
    ({ admissionClass, expected }) => {
      const { inboundFailureClass, attemptFailureClass } = finalizeRejection(admissionClass);
      // The durable inbound_events.failure_class carries the operator-facing
      // driver split, routed through the coerce gate (proves set membership).
      expect(inboundFailureClass).toBe(expected);
      // The subclass is carried durably on the terminal row so both lockstepped
      // ternaries (agent mapper + core contract) can agree on the mapping.
      expect(attemptFailureClass).toBe(expected);
    },
  );

  it('pages differently for a queue halt than for a benign capacity shed', () => {
    // The operational payoff: a deadlock (queue_halted) must be distinguishable
    // from a by-design backpressure shed (queue_full) in the failure_class bucket.
    const halted = finalizeRejection('queue_halted').inboundFailureClass;
    const shed = finalizeRejection('queue_full').inboundFailureClass;
    expect(halted).not.toBe(shed);
    expect(halted).not.toBe('unknown');
    expect(shed).not.toBe('unknown');
  });

  it('keeps a class-less admission rejection backward-compatible as unknown', () => {
    const { inboundFailureClass, attemptFailureClass } = finalizeRejection(undefined);
    // Legacy/undifferentiated rejections preserve the null attempt_failure_class
    // durable invariant and coerce to 'unknown'.
    expect(attemptFailureClass).toBeNull();
    expect(inboundFailureClass).toBe('unknown');
  });
});
