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
});
