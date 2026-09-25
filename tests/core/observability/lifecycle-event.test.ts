// FLOS Stage 1 — Contract E: the `whatsoup.lifecycle.event.v1` envelope
// (design §2). Closed phase set; correlation keys carried as they exist;
// boot_id + mono_ms clock fields from day one; attrs values closed to enums,
// ints, booleans, or keyed-digest strings — free-form text is the privacy
// leak Contract H exists to prevent, so it is rejected at the envelope.
import { describe, expect, it } from 'vitest';

import {
  LIFECYCLE_EVENT_SCHEMA_ID,
  LIFECYCLE_LANES,
  LIFECYCLE_PHASES,
  parseLifecycleEvent,
} from '../../../src/core/observability/lifecycle-event.ts';

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'whatsoup.lifecycle.event.v1',
    instance: 'instance-alpha',
    host: 'host-1',
    lane: 'L-SCH',
    origin_lane: null,
    work_id: 'work-0001',
    correlation: {
      trigger_occurrence_id: 'occ-7',
      inbound_seq: 913,
      logical_turn_id: 'turn-3',
    },
    phase: 'released',
    at_utc: '2026-08-29T03:00:00Z',
    boot_id: 'boot-abc',
    mono_ms: 12345,
    attrs: { manager_generation: 4, manager_digest: 'k1:' + 'a'.repeat(64) },
    ...overrides,
  };
}

describe('lifecycle event.v1 envelope (FLOS Contract E)', () => {
  it('exposes the design constants', () => {
    expect(LIFECYCLE_EVENT_SCHEMA_ID).toBe('whatsoup.lifecycle.event.v1');
    expect(LIFECYCLE_PHASES).toEqual([
      'admitted', 'dispatched', 'acknowledged', 'progress', 'tool_effect',
      'terminal_result', 'finalized', 'delivered', 'suppressed', 'released',
      'recovery_claimed', 'recovery_completed', 'reclaimed', 'abandoned',
    ]);
    expect(LIFECYCLE_LANES).toContain('L-SCH');
    expect(LIFECYCLE_LANES).toContain('L-INT');
  });

  it('parses a canonical event and returns typed data', () => {
    const parsed = parseLifecycleEvent(baseEvent());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.event.phase).toBe('released');
      expect(parsed.event.correlation.inbound_seq).toBe(913);
      expect(parsed.event.mono_ms).toBe(12345);
    }
  });

  it('accepts absent correlation keys (carry what exists at that point) but requires the object', () => {
    expect(parseLifecycleEvent(baseEvent({ correlation: {} })).ok).toBe(true);
    expect(parseLifecycleEvent(baseEvent({ correlation: undefined })).ok).toBe(false);
  });

  it('rejects an unknown phase, lane, or schema id (closed sets)', () => {
    expect(parseLifecycleEvent(baseEvent({ phase: 'completed' })).ok).toBe(false);
    expect(parseLifecycleEvent(baseEvent({ lane: 'L-XYZ' })).ok).toBe(false);
    expect(parseLifecycleEvent(baseEvent({ schema: 'whatsoup.lifecycle.event.v2' })).ok).toBe(false);
  });

  it('rejects negative or non-integer mono_ms and a non-string boot_id (clock model O4)', () => {
    expect(parseLifecycleEvent(baseEvent({ mono_ms: -1 })).ok).toBe(false);
    expect(parseLifecycleEvent(baseEvent({ mono_ms: 1.5 })).ok).toBe(false);
    expect(parseLifecycleEvent(baseEvent({ boot_id: 42 })).ok).toBe(false);
  });

  it('rejects free-form attr strings; accepts enums/ints/booleans and keyed digests', () => {
    // Keyed digest and enum-like short lowercase tokens are fine.
    expect(parseLifecycleEvent(baseEvent({ attrs: { delivery: 'proved', retry: 2, replay_safe: true } })).ok).toBe(true);
    // A free-form sentence (spaces) is content, not an enum — rejected.
    expect(parseLifecycleEvent(baseEvent({ attrs: { note: 'user said hello there' } })).ok).toBe(false);
    // Raw identifiers that look like phone numbers are rejected outright.
    expect(parseLifecycleEvent(baseEvent({ attrs: { who: '15555550123' } })).ok).toBe(false);
  });

  it('requires origin_lane on L-REC events (design §1: recovery always carries its origin)', () => {
    expect(parseLifecycleEvent(baseEvent({ lane: 'L-REC', origin_lane: 'L-INT' })).ok).toBe(true);
    expect(parseLifecycleEvent(baseEvent({ lane: 'L-REC', origin_lane: null })).ok).toBe(false);
  });

  it('rejects unknown envelope keys (additive-only within a major means the reader knows every key)', () => {
    expect(parseLifecycleEvent(baseEvent({ extra_field: 1 })).ok).toBe(false);
  });

  it('returns a field-scoped reason on failure, never throws', () => {
    const bad = parseLifecycleEvent(baseEvent({ phase: 'nope' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('phase');
    expect(parseLifecycleEvent(null).ok).toBe(false);
    expect(parseLifecycleEvent('x').ok).toBe(false);
  });
});
