import { describe, expect, it } from 'vitest';
import { parseSignalEnvelope } from '../../../src/fleet/incidents/envelope.ts';

function base(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    signalId: 'sig-001',
    kind: 'condition_observed',
    subject: 'host:alpha',
    conditionClass: 'selfcheck_drift',
    occurrenceId: 'occ-001',
    occurrenceSeq: 1,
    observedAt: '2026-07-28T12:00:00.000Z',
    ...overrides,
  });
}

describe('parseSignalEnvelope', () => {
  it('accepts a well-formed condition_observed envelope', () => {
    const result = parseSignalEnvelope(base());
    expect(result.ok).toBe(true);
    if (result.ok && result.envelope.kind === 'condition_observed') {
      expect(result.envelope.occurrenceId).toBe('occ-001');
    } else {
      throw new Error('expected a condition_observed envelope');
    }
  });

  it('rejects unknown top-level keys (closed schema)', () => {
    const result = parseSignalEnvelope(base({ freeFormEvidence: 'stack trace here' }));
    expect(result.ok).toBe(false);
  });

  it('rejects condition kinds without occurrence identity', () => {
    const result = parseSignalEnvelope(
      base({ occurrenceId: undefined, occurrenceSeq: undefined }),
    );
    expect(result.ok).toBe(false);
  });

  it('accepts heartbeat_observed without occurrence fields', () => {
    const result = parseSignalEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        signalId: 'hb-001',
        kind: 'heartbeat_observed',
        subject: 'host:alpha',
        observedAt: '2026-07-28T12:00:00.000Z',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects malformed observedAt timestamps', () => {
    const result = parseSignalEnvelope(base({ observedAt: 'yesterday-ish' }));
    expect(result.ok).toBe(false);
  });

  it('rejects nested objects in attributes', () => {
    const result = parseSignalEnvelope(base({ attributes: { nested: { deep: true } } }));
    expect(result.ok).toBe(false);
  });

  it('rejects oversized attribute values and oversized key counts', () => {
    const big = 'x'.repeat(300);
    expect(parseSignalEnvelope(base({ attributes: { note: big } })).ok).toBe(false);

    const many: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) many[`k${i}`] = i;
    expect(parseSignalEnvelope(base({ attributes: many })).ok).toBe(false);
  });

  it('rejects non-JSON input without throwing', () => {
    const result = parseSignalEnvelope('{not json');
    expect(result.ok).toBe(false);
  });

  it('rejects occurrence fields on non-condition kinds', () => {
    const result = parseSignalEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        signalId: 'hb-002',
        kind: 'heartbeat_observed',
        subject: 'host:alpha',
        occurrenceId: 'occ-smuggled',
        occurrenceSeq: 1,
        observedAt: '2026-07-28T12:00:00.000Z',
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects date-only and non-UTC observedAt timestamps', () => {
    expect(parseSignalEnvelope(base({ observedAt: '2026-07-28' })).ok).toBe(false);
    expect(parseSignalEnvelope(base({ observedAt: '2026-07-28T12:00:00+02:00' })).ok).toBe(false);
  });
});
