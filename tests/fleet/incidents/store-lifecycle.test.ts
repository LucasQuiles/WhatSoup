import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIncidentDb } from '../../../src/fleet/incidents/db.ts';
import { IncidentStore } from '../../../src/fleet/incidents/store.ts';

let dir: string;
let store: IncidentStore;

const PRODUCER = { producerId: 'prod-selfcheck-alpha', producerDomainId: 'dom-selfcheck' };
const NOW = new Date('2026-07-28T12:00:05.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-lifecycle-'));
  store = new IncidentStore(openIncidentDb(join(dir, 'incidents.db')));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function observed(signalId: string, occurrenceId: string, occurrenceSeq: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    signalId,
    kind: 'condition_observed',
    subject: 'host:alpha',
    conditionClass: 'selfcheck_drift',
    occurrenceId,
    occurrenceSeq,
    observedAt: '2026-07-28T12:00:00.000Z',
  });
}

describe('condition_observed lifecycle', () => {
  it('opens an incident with an open transition on first observation', () => {
    const result = store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('incident_opened');
    expect(result.receipt.incidentId).not.toBeNull();
    expect(result.receipt.transitionId).not.toBeNull();
  });

  it('updates the open episode on a newer observation of the same occurrence', () => {
    store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    const result = store.acceptSignal(observed('sig-2', 'occ-1', 2), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('incident_updated');
  });

  it('stores an out-of-order (stale seq) observation without advancing state', () => {
    store.acceptSignal(observed('sig-1', 'occ-1', 5), PRODUCER, NOW);
    const result = store.acceptSignal(observed('sig-late', 'occ-1', 3), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('stored_stale_observation');
  });

  it('supersedes the prior open episode when a newer occurrence opens', () => {
    const first = store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    const second = store.acceptSignal(observed('sig-9', 'occ-2', 1), PRODUCER, NOW);
    expect(second.outcome).toBe('accepted');
    if (first.outcome !== 'accepted' || second.outcome !== 'accepted') return;

    expect(second.receipt.disposition).toBe('incident_opened');
    expect(second.receipt.incidentId).not.toBe(first.receipt.incidentId);

    const prior = store.getIncident(first.receipt.incidentId as number);
    expect(prior?.conditionState).toBe('superseded');
    const priorTransitions = store.listTransitions(first.receipt.incidentId as number);
    expect(priorTransitions.map((t) => t.toState)).toEqual(['open', 'superseded']);
    expect(priorTransitions[1]?.reasonCode).toBe('newer_occurrence');
  });

  function recovered(signalId: string, occurrenceId: string, occurrenceSeq: number): string {
    return JSON.stringify({
      schemaVersion: 1,
      signalId,
      kind: 'condition_recovered',
      subject: 'host:alpha',
      conditionClass: 'selfcheck_drift',
      occurrenceId,
      occurrenceSeq,
      observedAt: '2026-07-28T12:01:00.000Z',
      recoveryProofClass: 'runtime_reverified',
    });
  }

  it('resolves the matching open occurrence with a verified_recovery transition', () => {
    const opened = store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    const result = store.acceptSignal(recovered('sig-r1', 'occ-1', 2), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (opened.outcome !== 'accepted' || result.outcome !== 'accepted') return;

    expect(result.receipt.disposition).toBe('incident_resolved');
    expect(result.receipt.incidentId).toBe(opened.receipt.incidentId);
    const projection = store.getIncident(opened.receipt.incidentId as number);
    expect(projection?.conditionState).toBe('resolved');
    const transitions = store.listTransitions(opened.receipt.incidentId as number);
    expect(transitions.at(-1)?.reasonCode).toBe('verified_recovery');
  });

  it('stores an unmatched recovery without altering any state', () => {
    const result = store.acceptSignal(recovered('sig-r2', 'occ-unknown', 1), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('stored_no_state_change');
    expect(result.receipt.incidentId).toBeNull();
  });

  it('does not re-resolve or reopen an already-resolved occurrence', () => {
    store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    store.acceptSignal(recovered('sig-r1', 'occ-1', 2), PRODUCER, NOW);
    const late = store.acceptSignal(recovered('sig-r3', 'occ-1', 3), PRODUCER, NOW);
    expect(late.outcome).toBe('accepted');
    if (late.outcome !== 'accepted') return;
    expect(late.receipt.disposition).toBe('stored_no_state_change');
  });

  it('stores an observation against a concluded occurrence as stored_no_state_change', () => {
    store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    store.acceptSignal(recovered('sig-r1', 'occ-1', 2), PRODUCER, NOW);
    const late = store.acceptSignal(observed('sig-post', 'occ-1', 3), PRODUCER, NOW);
    expect(late.outcome).toBe('accepted');
    if (late.outcome !== 'accepted') return;
    expect(late.receipt.disposition).toBe('stored_no_state_change');
    expect(late.receipt.incidentId).toBeNull();
  });

  it('quarantines future-skewed condition observations without lifecycle effects', () => {
    const future = JSON.stringify({
      schemaVersion: 1,
      signalId: 'sig-future',
      kind: 'condition_observed',
      subject: 'host:alpha',
      conditionClass: 'selfcheck_drift',
      occurrenceId: 'occ-f',
      occurrenceSeq: 1,
      observedAt: '2026-07-28T13:00:00.000Z', // ~1h ahead of NOW
    });
    const result = store.acceptSignal(future, PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('stored_quarantined_observation');
    expect(result.receipt.incidentId).toBeNull();
    expect(result.receipt.transitionId).toBeNull();
  });

  it('accepts observations within the permitted skew window normally', () => {
    const slightlyAhead = JSON.stringify({
      schemaVersion: 1,
      signalId: 'sig-skew-ok',
      kind: 'heartbeat_observed',
      subject: 'host:alpha',
      observedAt: '2026-07-28T12:02:00.000Z', // < 5 min ahead of NOW
    });
    const result = store.acceptSignal(slightlyAhead, PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('heartbeat_recorded');
  });

  it('honors a configured maxFutureSkewMs', () => {
    const strictDir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-strict-'));
    const strict = new IncidentStore(openIncidentDb(join(strictDir, 'incidents.db')), {
      maxFutureSkewMs: 0,
    });
    try {
      const result = strict.acceptSignal(
        JSON.stringify({
          schemaVersion: 1,
          signalId: 'hb-strict',
          kind: 'heartbeat_observed',
          subject: 'host:alpha',
          observedAt: '2026-07-28T12:00:06.000Z', // 1s ahead of NOW
        }),
        PRODUCER,
        NOW,
      );
      expect(result.outcome).toBe('accepted');
      if (result.outcome !== 'accepted') return;
      expect(result.receipt.disposition).toBe('stored_quarantined_observation');
    } finally {
      strict.close();
      rmSync(strictDir, { recursive: true, force: true });
    }
  });
});
