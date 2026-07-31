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
    // Strictly newer observedAt: supersession requires the new occurrence to
    // be fresher than every open episode, not merely different.
    const second = store.acceptSignal(
      JSON.stringify({
        schemaVersion: 1,
        signalId: 'sig-9',
        kind: 'condition_observed',
        subject: 'host:alpha',
        conditionClass: 'selfcheck_drift',
        occurrenceId: 'occ-2',
        occurrenceSeq: 1,
        observedAt: '2026-07-28T12:00:01.000Z',
      }),
      PRODUCER,
      NOW,
    );
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
    expect(store.listIncidents()).toEqual([]);
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
    const opened = store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    store.acceptSignal(recovered('sig-r1', 'occ-1', 2), PRODUCER, NOW);
    const late = store.acceptSignal(observed('sig-post', 'occ-1', 3), PRODUCER, NOW);
    expect(late.outcome).toBe('accepted');
    if (opened.outcome !== 'accepted' || late.outcome !== 'accepted') return;
    expect(late.receipt.disposition).toBe('stored_no_state_change');
    expect(late.receipt.incidentId).toBeNull();
    expect(store.getIncident(opened.receipt.incidentId as number)?.conditionState).toBe('resolved');
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
    expect(store.listIncidents()).toEqual([]);
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

  function observedWithTime(
    signalId: string,
    occurrenceId: string,
    occurrenceSeq: number,
    observedAtIso: string,
  ): string {
    return JSON.stringify({
      schemaVersion: 1,
      signalId,
      kind: 'condition_observed',
      subject: 'host:alpha',
      conditionClass: 'selfcheck_drift',
      occurrenceId,
      occurrenceSeq,
      observedAt: observedAtIso,
    });
  }

  describe('stale recovery is causally inert', () => {
    it('does not resolve on a recovery with an older sequence', () => {
      const opened = store.acceptSignal(observed('sig-1', 'occ-1', 5), PRODUCER, NOW);
      if (opened.outcome !== 'accepted') throw new Error('setup: open failed');
      const incidentId = opened.receipt.incidentId as number;
      const before = store.getIncident(incidentId);
      const beforeTransitions = store.listTransitions(incidentId);

      const stale = store.acceptSignal(recovered('sig-r-old', 'occ-1', 3), PRODUCER, NOW);
      expect(stale.outcome).toBe('accepted');
      if (stale.outcome !== 'accepted') return;
      expect(stale.receipt.disposition).toBe('stored_stale_observation');
      expect(stale.receipt.incidentId).toBe(incidentId);

      const after = store.getIncident(incidentId);
      expect(after?.conditionState).toBe('open');
      expect(after?.projectionVersion).toBe(before?.projectionVersion);
      expect(store.listTransitions(incidentId)).toEqual(beforeTransitions);
    });

    it('does not resolve on a recovery with an equal sequence', () => {
      const opened = store.acceptSignal(observed('sig-1', 'occ-1', 5), PRODUCER, NOW);
      if (opened.outcome !== 'accepted') throw new Error('setup: open failed');
      const incidentId = opened.receipt.incidentId as number;

      const equal = store.acceptSignal(recovered('sig-r-eq', 'occ-1', 5), PRODUCER, NOW);
      expect(equal.outcome).toBe('accepted');
      if (equal.outcome !== 'accepted') return;
      expect(equal.receipt.disposition).toBe('stored_stale_observation');
      expect(equal.receipt.incidentId).toBe(incidentId);
      expect(store.getIncident(incidentId)?.conditionState).toBe('open');
    });

    it('replays the original state-inert receipt on exact resend', () => {
      store.acceptSignal(observed('sig-1', 'occ-1', 5), PRODUCER, NOW);
      const body = recovered('sig-r-old', 'occ-1', 3);
      const first = store.acceptSignal(body, PRODUCER, NOW);
      const replay = store.acceptSignal(body, PRODUCER, new Date('2026-07-28T12:30:00.000Z'));
      expect(replay.outcome).toBe('idempotent_replay');
      if (first.outcome !== 'accepted' || replay.outcome !== 'idempotent_replay') return;
      expect(replay.receipt).toEqual(first.receipt);
    });

    it('still resolves on a causally newer recovery', () => {
      const opened = store.acceptSignal(observed('sig-1', 'occ-1', 5), PRODUCER, NOW);
      if (opened.outcome !== 'accepted') throw new Error('setup: open failed');
      const result = store.acceptSignal(recovered('sig-r-new', 'occ-1', 6), PRODUCER, NOW);
      expect(result.outcome).toBe('accepted');
      if (result.outcome !== 'accepted') return;
      expect(result.receipt.disposition).toBe('incident_resolved');
    });
  });

  describe('cross-occurrence supersession is order-guarded', () => {
    it('does not let a late occurrence with an older timestamp supersede a fresher episode', () => {
      const fresh = store.acceptSignal(
        observedWithTime('sig-b', 'occ-b', 1, '2026-07-28T12:00:00.000Z'),
        PRODUCER,
        NOW,
      );
      if (fresh.outcome !== 'accepted') throw new Error('setup: open failed');
      const freshId = fresh.receipt.incidentId as number;

      const late = store.acceptSignal(
        observedWithTime('sig-a-late', 'occ-a', 7, '2026-07-28T11:00:00.000Z'),
        PRODUCER,
        NOW,
      );
      expect(late.outcome).toBe('accepted');
      if (late.outcome !== 'accepted') return;
      expect(late.receipt.disposition).toBe('stored_stale_observation');
      expect(late.receipt.transitionId).toBeNull();

      expect(store.getIncident(freshId)?.conditionState).toBe('open');
      expect(store.listIncidents().filter((i) => i.occurrenceId === 'occ-a')).toEqual([]);
    });

    it('does not let an equal-timestamp occurrence supersede an open episode', () => {
      const fresh = store.acceptSignal(
        observedWithTime('sig-b', 'occ-b', 1, '2026-07-28T12:00:00.000Z'),
        PRODUCER,
        NOW,
      );
      if (fresh.outcome !== 'accepted') throw new Error('setup: open failed');

      const equal = store.acceptSignal(
        observedWithTime('sig-a-eq', 'occ-a', 1, '2026-07-28T12:00:00.000Z'),
        PRODUCER,
        NOW,
      );
      expect(equal.outcome).toBe('accepted');
      if (equal.outcome !== 'accepted') return;
      expect(equal.receipt.disposition).toBe('stored_stale_observation');
      expect(store.getIncident(fresh.receipt.incidentId as number)?.conditionState).toBe('open');
      expect(store.listIncidents().filter((i) => i.occurrenceId === 'occ-a')).toEqual([]);
    });

    it('still supersedes on a strictly newer occurrence', () => {
      const older = store.acceptSignal(
        observedWithTime('sig-b', 'occ-b', 1, '2026-07-28T12:00:00.000Z'),
        PRODUCER,
        NOW,
      );
      if (older.outcome !== 'accepted') throw new Error('setup: open failed');

      const newer = store.acceptSignal(
        observedWithTime('sig-c', 'occ-c', 1, '2026-07-28T12:00:01.000Z'),
        PRODUCER,
        NOW,
      );
      expect(newer.outcome).toBe('accepted');
      if (newer.outcome !== 'accepted') return;
      expect(newer.receipt.disposition).toBe('incident_opened');
      expect(store.getIncident(older.receipt.incidentId as number)?.conditionState).toBe('superseded');
    });
  });

  describe('observed freshness is advance-only', () => {
    it('advances the sequence without regressing last_observed_at', () => {
      const opened = store.acceptSignal(
        observedWithTime('sig-1', 'occ-1', 5, '2026-07-28T12:00:02.000Z'),
        PRODUCER,
        NOW,
      );
      if (opened.outcome !== 'accepted') throw new Error('setup: open failed');
      const incidentId = opened.receipt.incidentId as number;
      const beforeVersion = store.getIncident(incidentId)?.projectionVersion ?? 0;

      const result = store.acceptSignal(
        observedWithTime('sig-2', 'occ-1', 6, '2026-07-28T12:00:01.000Z'),
        PRODUCER,
        NOW,
      );
      expect(result.outcome).toBe('accepted');
      if (result.outcome !== 'accepted') return;
      expect(result.receipt.disposition).toBe('incident_updated');

      const projection = store.getIncident(incidentId);
      expect(projection?.lastOccurrenceSeq).toBe(6);
      expect(projection?.lastObservedAt).toBe('2026-07-28T12:00:02.000Z');
      expect(projection?.projectionVersion).toBe(beforeVersion + 1);
    });

    it('advances last_observed_at when the newer sequence is also newer in time', () => {
      const opened = store.acceptSignal(
        observedWithTime('sig-1', 'occ-1', 5, '2026-07-28T12:00:01.000Z'),
        PRODUCER,
        NOW,
      );
      if (opened.outcome !== 'accepted') throw new Error('setup: open failed');
      const incidentId = opened.receipt.incidentId as number;

      const result = store.acceptSignal(
        observedWithTime('sig-2', 'occ-1', 6, '2026-07-28T12:00:03.000Z'),
        PRODUCER,
        NOW,
      );
      expect(result.outcome).toBe('accepted');
      const projection = store.getIncident(incidentId);
      expect(projection?.lastOccurrenceSeq).toBe(6);
      expect(projection?.lastObservedAt).toBe('2026-07-28T12:00:03.000Z');
    });
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
