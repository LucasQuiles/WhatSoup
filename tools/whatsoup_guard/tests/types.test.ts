import { describe, expect, it } from 'vitest';
import {
  EventSchema, MuteSchema, ProbeDocSchema, BaselineRowSchema,
  type Event, type Mute, type ProbeDoc, type BaselineRow,
} from '../src/types.ts';

describe('types', () => {
  const validEvent = {
    id: 1,
    ts: '2026-05-08T14:32:11Z',
    kind: 'drift',
    domain: 'exposure',
    scope_id: 'host.example',
    probe_id: 'host.example.ports',
    severity: 'crit',
    fingerprint: 'a'.repeat(64),
    correlation_id: 'corr-a',
    payload: { diff: '+ port 11434' },
    alerted_to: 'whatsoup',
  } satisfies Event;

  const validMute = {
    id: 1,
    host: 'h',
    domain: 'exposure',
    expires_at: '2026-05-08T15:00:00Z',
    reason: 'test',
    allow_revert_suppression: false,
    created_by: 'op',
  } satisfies Mute;

  const validProbeDoc = {
    probe_id: 'p',
    scope_id: 's',
    captured_at: 't',
    fields: { a: 1 },
  } satisfies ProbeDoc;

  const validBaselineRow = {
    probe_id: 'p',
    scope_id: 's',
    expected_doc: '{"a":1}',
    captured_at: 't',
    captured_by: 'op',
    hmac: 'x'.repeat(64),
  } satisfies BaselineRow;

  it('parses a valid Event', () => {
    expect(EventSchema.parse(validEvent).fingerprint?.length).toBe(64);
  });

  it('rejects an unknown event kind', () => {
    expect(() => EventSchema.parse({ id: 1, ts: 'x', kind: 'made_up', payload: {} })).toThrow();
  });

  it.each(['revert_applied', 'revert_failed', 'baseline_set'])('rejects deprecated event kind %s', (kind) => {
    expect(() => EventSchema.parse({ id: 1, ts: 'x', kind, payload: {} })).toThrow();
  });

  it('rejects unknown Event fields', () => {
    expect(() => EventSchema.parse({ ...validEvent, unexpected: true })).toThrow();
  });

  it('rejects Event fingerprints with the wrong length', () => {
    expect(() => EventSchema.parse({ ...validEvent, fingerprint: 'a'.repeat(63) })).toThrow();
  });

  it('parses the jsonl mirror failure event kind with a correlation id', () => {
    expect(EventSchema.parse({
      id: 2,
      ts: '2026-05-08T14:32:12Z',
      kind: 'jsonl_mirror_failed',
      correlation_id: 'corr-a',
      severity: 'low',
      payload: { original_event_id: 1 },
    }).kind).toBe('jsonl_mirror_failed');
  });

  it('parses a Mute with allow_revert_suppression default false', () => {
    const m: Mute = MuteSchema.parse({
      id: 1, host: 'h', domain: 'exposure',
      expires_at: '2026-05-08T15:00:00Z',
      reason: 'test', created_by: 'op',
    });
    expect(m.allow_revert_suppression).toBe(false);
  });

  it('rejects unknown Mute fields', () => {
    expect(() => MuteSchema.parse({ ...validMute, unexpected: true })).toThrow();
  });

  it('parses a ProbeDoc and a BaselineRow', () => {
    const doc: ProbeDoc = ProbeDocSchema.parse(validProbeDoc);
    expect(doc.fields).toEqual({ a: 1 });
    const row: BaselineRow = BaselineRowSchema.parse(validBaselineRow);
    expect(row.hmac.length).toBe(64);
  });

  it('rejects unknown ProbeDoc fields', () => {
    expect(() => ProbeDocSchema.parse({ ...validProbeDoc, unexpected: true })).toThrow();
  });

  it('rejects unknown BaselineRow fields', () => {
    expect(() => BaselineRowSchema.parse({ ...validBaselineRow, unexpected: true })).toThrow();
  });

  it('rejects BaselineRow HMACs with the wrong length', () => {
    expect(() => BaselineRowSchema.parse({ ...validBaselineRow, hmac: 'x'.repeat(63) })).toThrow();
  });
});
