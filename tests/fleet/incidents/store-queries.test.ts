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
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-queries-'));
  store = new IncidentStore(openIncidentDb(join(dir, 'incidents.db')));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function observedOn(subject: string, occurrenceId: string, signalId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    signalId,
    kind: 'condition_observed',
    subject,
    conditionClass: 'selfcheck_drift',
    occurrenceId,
    occurrenceSeq: 1,
    observedAt: '2026-07-28T12:00:00.000Z',
  });
}

describe('incident store read queries', () => {
  it('filters by exact subject', () => {
    store.acceptSignal(observedOn('host:alpha', 'occ-a', 'sig-a'), PRODUCER, NOW);
    store.acceptSignal(observedOn('host:beta', 'occ-b', 'sig-b'), PRODUCER, NOW);

    const results = store.listIncidents({ subject: 'host:alpha' });
    expect(results).toHaveLength(1);
    expect(results[0]?.subject).toBe('host:alpha');
  });

  it('filters by condition state and paginates by afterIncidentId', () => {
    store.acceptSignal(observedOn('host:alpha', 'occ-a', 'sig-a'), PRODUCER, NOW);
    store.acceptSignal(observedOn('host:beta', 'occ-b', 'sig-b'), PRODUCER, NOW);

    const open = store.listIncidents({ conditionState: 'open' });
    expect(open).toHaveLength(2);

    const afterFirst = store.listIncidents({ afterIncidentId: open[0]!.incidentId });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.incidentId).toBe(open[1]!.incidentId);
  });

  it('returns stored events without exposing raw payload bytes', () => {
    const accepted = store.acceptSignal(observedOn('host:alpha', 'occ-a', 'sig-a'), PRODUCER, NOW);
    if (accepted.outcome !== 'accepted') throw new Error('setup failed');

    const event = store.getEvent(accepted.receipt.eventId);
    expect(event?.signalId).toBe('sig-a');
    expect(event?.disposition).toBe('incident_opened');
    expect(event as unknown as Record<string, unknown>).not.toHaveProperty('payloadJson');
    expect(event as unknown as Record<string, unknown>).not.toHaveProperty('payload_json');
  });

  it('returns null for unknown ids', () => {
    expect(store.getEvent(999)).toBeNull();
    expect(store.getIncident(999)).toBeNull();
  });
});
