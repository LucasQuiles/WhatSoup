import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIncidentDb } from '../../../src/fleet/incidents/db.ts';
import { IncidentStore, type PhaseActorContext } from '../../../src/fleet/incidents/store.ts';
import type { IncidentPhaseKind } from '../../../src/fleet/incidents/phase-envelope.ts';

let dir: string;
let store: IncidentStore;
let incidentId: number;
let sourceEventId: number;

const NOW = new Date('2026-07-28T12:30:00.000Z');
const OBSERVER = { producerId: 'observer-a', producerDomainId: 'bot-errors' };

const actors = {
  notifier: { producerId: 'notifier-a', producerDomainId: 'bot-errors', actorClass: 'notifier' },
  q_receiver: { producerId: 'q-a', producerDomainId: 'bot-errors', actorClass: 'q_receiver' },
  diagnostician: { producerId: 'diagnostician-a', producerDomainId: 'bot-errors', actorClass: 'diagnostician' },
  approver: { producerId: 'approver-a', producerDomainId: 'bot-errors', actorClass: 'approver' },
  executor: { producerId: 'executor-a', producerDomainId: 'bot-errors', actorClass: 'executor' },
  recovery_witness: { producerId: 'witness-a', producerDomainId: 'bot-errors', actorClass: 'recovery_witness' },
} satisfies Record<string, PhaseActorContext>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-phase-facts-'));
  store = new IncidentStore(openIncidentDb(join(dir, 'incidents.db')));
  const opened = store.acceptSignal(JSON.stringify({
    schemaVersion: 1,
    signalId: 'condition-1',
    kind: 'condition_observed',
    subject: 'bot-errors',
    conditionClass: 'bot_errors_alert',
    occurrenceId: 'occ-1',
    occurrenceSeq: 1,
    observedAt: '2026-07-28T12:00:00.000Z',
  }), OBSERVER, NOW);
  if (opened.outcome !== 'accepted' || opened.receipt.incidentId === null) throw new Error('setup failed');
  incidentId = opened.receipt.incidentId;
  sourceEventId = opened.receipt.eventId;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function fact(
  factId: string,
  phase: IncidentPhaseKind,
  observedAt: string,
  relatedFactId?: string,
  evidenceClass?: string,
  evidenceDigest?: string,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    factId,
    incidentId,
    occurrenceId: 'occ-1',
    phase,
    sourceEventId,
    observedAt,
    ...(relatedFactId ? { relatedFactId } : {}),
    ...(evidenceClass ? { evidenceClass } : {}),
    ...(evidenceDigest ? { evidenceDigest } : {}),
  });
}

function accept(
  factId: string,
  phase: IncidentPhaseKind,
  actor: PhaseActorContext,
  minute: number,
  relatedFactId?: string,
  evidenceClass?: string,
  evidenceDigest?: string,
) {
  return store.acceptPhaseFact(
    fact(
      factId,
      phase,
      `2026-07-28T12:${String(minute).padStart(2, '0')}:00.000Z`,
      relatedFactId,
      evidenceClass,
      evidenceDigest,
    ),
    actor,
    NOW,
  );
}

function acceptedChainThroughExecution(): void {
  expect(accept('notify-1', 'notification_delivered', actors.notifier, 1).outcome).toBe('accepted');
  expect(accept('q-1', 'q_receipt', actors.q_receiver, 2, 'notify-1').outcome).toBe('accepted');
  expect(accept('diagnosis-1', 'diagnosis_recorded', actors.diagnostician, 3, 'q-1').outcome).toBe('accepted');
  expect(accept('approval-1', 'change_approved', actors.approver, 4, 'diagnosis-1').outcome).toBe('accepted');
  expect(accept('execution-1', 'execution_recorded', actors.executor, 5, 'approval-1').outcome).toBe('accepted');
}

describe('IncidentStore phase facts', () => {
  it('records each phase separately and resolves only on independent fresh recovery', () => {
    acceptedChainThroughExecution();
    const recovered = accept(
      'recovery-1',
      'recovery_confirmed',
      actors.recovery_witness,
      6,
      'execution-1',
      'runtime_reverified',
      `sha256:${'a'.repeat(64)}`,
    );
    expect(recovered.outcome).toBe('accepted');
    if (recovered.outcome !== 'accepted') return;
    expect(recovered.receipt).toMatchObject({
      disposition: 'phase_recorded',
      reasonCode: 'accepted',
      incidentId,
    });
    expect(recovered.receipt.transitionId).not.toBeNull();
    expect(store.getIncident(incidentId)?.conditionState).toBe('resolved');
  });

  it('keeps missing predecessors, self-approval, and self-confirmation state-inert', () => {
    const missing = accept('execution-missing', 'execution_recorded', actors.executor, 2, 'no-approval');
    expect(missing.outcome).toBe('accepted');
    if (missing.outcome !== 'accepted') return;
    expect(missing.receipt).toMatchObject({ disposition: 'stored_state_inert', reasonCode: 'predecessor_missing' });

    accept('notify-1', 'notification_delivered', actors.notifier, 1);
    accept('q-1', 'q_receipt', actors.q_receiver, 2, 'notify-1');
    accept('diagnosis-1', 'diagnosis_recorded', actors.diagnostician, 3, 'q-1');
    accept('approval-1', 'change_approved', actors.approver, 4, 'diagnosis-1');
    const selfExecution = accept(
      'execution-self',
      'execution_recorded',
      { ...actors.executor, producerId: actors.approver.producerId },
      5,
      'approval-1',
    );
    expect(selfExecution.outcome).toBe('accepted');
    if (selfExecution.outcome !== 'accepted') return;
    expect(selfExecution.receipt.reasonCode).toBe('self_approved_execution');

    accept('execution-1', 'execution_recorded', actors.executor, 5, 'approval-1');
    const selfRecovery = accept(
      'recovery-self',
      'recovery_confirmed',
      { ...actors.recovery_witness, producerId: actors.executor.producerId },
      6,
      'execution-1',
      'runtime_reverified',
      `sha256:${'b'.repeat(64)}`,
    );
    expect(selfRecovery.outcome).toBe('accepted');
    if (selfRecovery.outcome !== 'accepted') return;
    expect(selfRecovery.receipt.reasonCode).toBe('self_confirmed_recovery');
    expect(store.getIncident(incidentId)?.conditionState).toBe('open');
  });

  it('returns the original receipt for exact replay and conflict for changed bytes', () => {
    const body = fact('notify-1', 'notification_delivered', '2026-07-28T12:01:00.000Z');
    const first = store.acceptPhaseFact(body, actors.notifier, NOW);
    const replay = store.acceptPhaseFact(body, actors.notifier, NOW);
    const conflict = store.acceptPhaseFact(
      fact('notify-1', 'notification_delivered', '2026-07-28T12:02:00.000Z'),
      actors.notifier,
      NOW,
    );
    expect(replay.outcome).toBe('idempotent_replay');
    if (first.outcome === 'accepted' && replay.outcome === 'idempotent_replay') {
      expect(replay.receipt).toEqual(first.receipt);
    }
    expect(conflict.outcome).toBe('identity_conflict');
  });

  it('keeps a second repair-phase attempt durable and state-inert', () => {
    const first = accept('notify-1', 'notification_delivered', actors.notifier, 1);
    const second = accept(
      'notify-2',
      'notification_delivered',
      { ...actors.notifier, producerId: 'notifier-b' },
      2,
    );
    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('accepted');
    if (second.outcome !== 'accepted') return;
    expect(second.receipt).toMatchObject({
      disposition: 'stored_state_inert',
      reasonCode: 'phase_already_recorded',
    });
  });

  it('keeps a phase producer from another incident domain state-inert', () => {
    const result = accept(
      'notify-foreign',
      'notification_delivered',
      { ...actors.notifier, producerDomainId: 'another-domain' },
      1,
    );
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt).toMatchObject({
      disposition: 'stored_state_inert',
      reasonCode: 'producer_domain_mismatch',
    });
  });

  it.each([
    ['unsupported_recovery_evidence', 'untrusted_claim', `sha256:${'c'.repeat(64)}`],
    ['invalid_recovery_evidence_digest', 'runtime_reverified', 'sha256:not-a-digest'],
  ])('stores poisoned recovery proof as %s without resolving', (reasonCode, evidenceClass, evidenceDigest) => {
    acceptedChainThroughExecution();
    const result = accept(
      `recovery-${reasonCode}`,
      'recovery_confirmed',
      actors.recovery_witness,
      6,
      'execution-1',
      evidenceClass,
      evidenceDigest,
    );
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt).toMatchObject({ disposition: 'stored_state_inert', reasonCode });
    expect(store.getIncident(incidentId)?.conditionState).toBe('open');
  });

  it('stores stale and future recovery proof without resolving', () => {
    acceptedChainThroughExecution();
    const stale = accept(
      'recovery-stale',
      'recovery_confirmed',
      actors.recovery_witness,
      5,
      'execution-1',
      'runtime_reverified',
      `sha256:${'d'.repeat(64)}`,
    );
    expect(stale.outcome).toBe('accepted');
    if (stale.outcome !== 'accepted') return;
    expect(stale.receipt.reasonCode).toBe('stale_phase_fact');

    const future = store.acceptPhaseFact(
      fact(
        'recovery-future',
        'recovery_confirmed',
        '2026-07-28T12:36:00.000Z',
        'execution-1',
        'runtime_reverified',
        `sha256:${'e'.repeat(64)}`,
      ),
      actors.recovery_witness,
      NOW,
    );
    expect(future.outcome).toBe('accepted');
    if (future.outcome !== 'accepted') return;
    expect(future.receipt.reasonCode).toBe('future_observation');
    expect(store.getIncident(incidentId)?.conditionState).toBe('open');
  });
});
