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
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-store-'));
  store = new IncidentStore(openIncidentDb(join(dir, 'incidents.db')));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function heartbeatBody(signalId = 'hb-001'): string {
  return JSON.stringify({
    schemaVersion: 1,
    signalId,
    kind: 'heartbeat_observed',
    subject: 'host:alpha',
    observedAt: '2026-07-28T12:00:00.000Z',
  });
}

describe('IncidentStore.acceptSignal — acceptance core', () => {
  it('accepts a heartbeat with a durable receipt and sha256 digest', () => {
    const result = store.acceptSignal(heartbeatBody(), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('heartbeat_recorded');
    expect(result.receipt.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.receipt.incidentId).toBeNull();
    expect(result.receipt.receivedAt).toBe(NOW.toISOString());
  });

  it('returns the original receipt on exact byte replay without new events', () => {
    const body = heartbeatBody();
    const first = store.acceptSignal(body, PRODUCER, NOW);
    const replay = store.acceptSignal(body, PRODUCER, new Date('2026-07-28T12:10:00.000Z'));

    expect(replay.outcome).toBe('idempotent_replay');
    if (first.outcome !== 'accepted' || replay.outcome !== 'idempotent_replay') return;
    expect(replay.receipt).toEqual(first.receipt);
  });

  it('rejects the same signal identity with different bytes as a conflict', () => {
    store.acceptSignal(heartbeatBody(), PRODUCER, NOW);
    const conflicting = JSON.stringify({
      schemaVersion: 1,
      signalId: 'hb-001',
      kind: 'heartbeat_observed',
      subject: 'host:alpha',
      observedAt: '2026-07-28T12:00:01.000Z',
    });
    const result = store.acceptSignal(conflicting, PRODUCER, NOW);
    expect(result.outcome).toBe('identity_conflict');
  });

  it('scopes identity per producer: same signalId from another producer is accepted', () => {
    store.acceptSignal(heartbeatBody(), PRODUCER, NOW);
    const other = { producerId: 'prod-selfcheck-beta', producerDomainId: 'dom-selfcheck' };
    const result = store.acceptSignal(heartbeatBody(), other, NOW);
    expect(result.outcome).toBe('accepted');
  });

  it('returns invalid (not a throw, no stored event) for schema violations', () => {
    const result = store.acceptSignal('{"nope": true}', PRODUCER, NOW);
    expect(result.outcome).toBe('invalid');
    const replay = store.acceptSignal(heartbeatBody(), PRODUCER, NOW);
    expect(replay.outcome).toBe('accepted');
  });

  it('records notice_recorded without opening an incident', () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      signalId: 'note-001',
      kind: 'notice_recorded',
      subject: 'host:alpha',
      observedAt: '2026-07-28T12:00:00.000Z',
      attributes: { outcomeClass: 'session_terminal' },
    });
    const result = store.acceptSignal(body, PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('notice_recorded');
    expect(result.receipt.incidentId).toBeNull();
  });
});
